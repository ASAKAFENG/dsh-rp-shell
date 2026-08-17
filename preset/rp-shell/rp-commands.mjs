/**
 * rp-commands: 角色扮演（RP Shell）预设的命令、角色卡与记忆插件。
 *
 * 职责：
 *  1. 注册 `/char` `/reset` `/roll` `/status` `/memory` 命令（写入 `commands`
 *     注册表，对本预设挂载的所有会话可见）。
 *  2. `/char <文本>` 或 `/char load <路径>`：导入角色卡。文本直接使用；
 *     路径从文件读取（支持 SKILL.md——自动剥离 YAML frontmatter 后取正文）。
 *     角色卡写入持久会话事件（`rp/character`），并通过 `agent.ctx.systemPrompt
 *     .section()` 注入为 per-agent 系统提示词区段，使模型每次请求都严格遵循。
 *  3. `/memory load <路径>`：加载用户写的记忆文件（任意 .md/.txt），同样持久化
 *     （`rp/memory`）并注入 per-agent 提示词区段；区段内声明记忆文件路径与
 *     自主更新规则，扮演中 agent 用文件工具（read/write/edit）主动读写该文件，
 *     实现"自主更新记忆"。
 *  4. `/reset` 清除角色卡；`/memory clear` 清除记忆区段。
 *  5. 会话启动/恢复（`agent/session-start`）时，从会话日志重放最后一条
 *     `rp/character` 与 `rp/memory` 事件，设定与记忆在重启/恢复后依然生效。
 *
 * 依赖：仅 node 内置模块（node:fs/promises / node:path）+ 注入的 `commands`
 * 服务。相对 preset 行从用户 home 解析 bare specifier（那里没有安装
 * `@deepseek-ai/*`），因此本文件不 import 任何第三方包。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'rp-commands'

/** 命令注册表必须在场；systemPrompt 通过 `invocation.agent.ctx` 访问。 */
export const inject = ['commands']

/** 角色卡与记忆的持久会话事件类型（非 surface，不进入模型对话表面）。 */
const CHARACTER_EVENT = 'rp/character'
const MEMORY_EVENT = 'rp/memory'

/** 系统提示词区段名与排序：persona 为 0，角色卡 1，记忆 2。 */
const CARD_SECTION = 'rp:character-card'
const CARD_ORDER = 1
const MEMORY_SECTION = 'rp:memory-file'
const MEMORY_ORDER = 2

/** 解析用户输入路径：绝对路径直接用，相对路径基于会话工作区。 */
function resolvePath(agent, p) {
  const cwd = agent?.session?.header?.cwd || process.cwd()
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/**
 * 解析 SKILL.md / 带 frontmatter 的文件：提取 YAML frontmatter（元信息），
 * 返回 { frontmatter, body }。无 frontmatter 时 body 为全文。
 */
function parseSkillFile(content) {
  const text = content.replace(/^\uFEFF/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m === null) return { frontmatter: {}, body: text.trim() }
  const raw = m[1]
  const frontmatter = {}
  for (const line of raw.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (kv !== null) frontmatter[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '')
  }
  return { frontmatter, body: text.slice(m[0].length).trim() }
}

/** 角色卡区段模板：`{{card}}` 被替换为导入文本。 */
function cardSectionText(card) {
  return [
    '【角色卡 · Character Card】',
    '',
    card,
    '',
    '以上是用户导入的角色设定。你必须严格、完整地遵循其中的全部设定：人格、记忆、',
    '说话方式、行为准则、世界观、能力与限制。设定中未规定的细节按设定精神自然补全；',
    '不得添加设定之外的额外限制或说教。用户的直接指令优先于默认行为。',
    '',
    '【终端控制权 · Terminal Access】',
    '',
    '你拥有这台 Linux 电脑的终端控制权：通过 Shell（bash）工具在终端真实执行命令、',
    '读写文件、操作程序与系统。用户说"用命令做某事"时，必须实际调用终端工具执行并',
    '留下可验证的真实结果，而不是口头描述。在扮演中也可以主动用终端完成设定相关的',
    '动作（查资料、生成文本、运行脚本、控制系统）。',
  ].join('\n')
}

/** 记忆区段模板：`{{path}}` 为记忆文件路径，`{{text}}` 为当前内容。 */
function memorySectionText(path, text) {
  return [
    '【记忆文件 · Memory File】',
    '',
    `路径：${path}`,
    '',
    '以下是这个角色/扮演的长期记忆文件内容（用户书写，agent 可自主维护）：',
    '',
    text,
    '',
    '【记忆维护规则】',
    '',
    '1. 记忆文件是跨会话的持久记忆。扮演中产生的值得记住的新信息——新认识的人、',
    '   发生的重要事件、关系的变化、用户透露的偏好与秘密、剧情的推进、设定的补充——',
    '   应当主动使用文件工具（read 先读当前内容，再用 write/edit 合并更新）写回该文件。',
    '2. 更新时保留已有内容，只追加或修订；不要整体清空，除非用户明确要求。',
    '3. 每次写入后，后续回应要基于更新后的记忆保持一致。',
    '4. 用户也可以用 /memory load <路径> 随时重新加载，或用 /memory clear 清除。',
  ].join('\n')
}

export function apply(ctx) {
  /** sessionId -> 当前角色卡区段的 disposer。 */
  const cardSections = new Map()
  /** sessionId -> 当前记忆区段的 disposer。 */
  const memorySections = new Map()

  /** 为指定 agent 注入角色卡区段（先移除旧区段）。 */
  function applyCard(agent, text) {
    const old = cardSections.get(agent.id)
    if (old) old()
    const dispose = agent.ctx.systemPrompt.section({
      name: CARD_SECTION,
      order: CARD_ORDER,
      text: cardSectionText(text),
    })
    cardSections.set(agent.id, dispose)
  }

  /** 清除指定 agent 的角色卡区段。 */
  function clearCard(agent) {
    const old = cardSections.get(agent.id)
    if (old) {
      old()
      cardSections.delete(agent.id)
    }
  }

  /** 为指定 agent 注入记忆区段（先移除旧区段）。 */
  function applyMemory(agent, path, text) {
    const old = memorySections.get(agent.id)
    if (old) old()
    const dispose = agent.ctx.systemPrompt.section({
      name: MEMORY_SECTION,
      order: MEMORY_ORDER,
      text: memorySectionText(path, text),
    })
    memorySections.set(agent.id, dispose)
  }

  /** 清除指定 agent 的记忆区段。 */
  function clearMemory(agent) {
    const old = memorySections.get(agent.id)
    if (old) {
      old()
      memorySections.delete(agent.id)
    }
  }

  // ── 会话启动/恢复：重放最后一条角色卡与记忆事件 ──────────────────────────
  ctx.on('agent/session-start', ({ agent }) => {
    let card = null
    let memory = null
    for (const event of agent.session.events) {
      if (event.type === CHARACTER_EVENT) card = event.data
      else if (event.type === MEMORY_EVENT) memory = event.data
    }
    if (card !== null) {
      if (card.clear) clearCard(agent)
      else if (typeof card.text === 'string') applyCard(agent, card.text)
    }
    if (memory !== null) {
      if (memory.clear) clearMemory(agent)
      else if (typeof memory.path === 'string' && typeof memory.text === 'string') {
        applyMemory(agent, memory.path, memory.text)
      }
    }
  })

  // agent 销毁时清理其区段（disposer 本身已随 agent.ctx 卸载，此处兜底）。
  ctx.on('agent/disposed', ({ agent }) => {
    const card = cardSections.get(agent.id)
    if (card) {
      card()
      cardSections.delete(agent.id)
    }
    const memory = memorySections.get(agent.id)
    if (memory) {
      memory()
      memorySections.delete(agent.id)
    }
  })

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'char',
      description: '导入角色卡：/char <文本> 或 /char load <路径>（支持 SKILL.md）',
      input: { hint: '角色卡内容或 load <路径>' },
      handler: async (invocation) => {
        const rest = invocation.rawInput.trim()
        // 子命令：/char load <路径> 或 /char file <路径>——从文件加载
        const load = /^(?:load|file)\s+(.+)$/.exec(rest)
        if (load !== null) {
          const filePath = resolvePath(invocation.agent, load[1].trim())
          let raw
          try {
            raw = await readFile(filePath, 'utf8')
          } catch (error) {
            return {
              kind: 'error',
              text: `无法读取文件 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
            }
          }
          const { frontmatter, body } = parseSkillFile(raw)
          if (!body) {
            return { kind: 'error', text: `文件 ${filePath} 内容为空。` }
          }
          const meta = frontmatter.name ? `（name: ${frontmatter.name}${frontmatter.description ? `, ${frontmatter.description}` : ''}）` : ''
          invocation.agent.session.append(CHARACTER_EVENT, { text: body, source: filePath })
          applyCard(invocation.agent, body)
          return {
            kind: 'success',
            text: `角色卡已从文件加载${meta}：${filePath}（${body.length} 字符）。从现在起我将严格遵循该设定。`,
          }
        }
        // 直接文本导入
        if (!rest) {
          return {
            kind: 'error',
            text: '用法：/char <角色卡内容>，或 /char load <路径> 从文件（含 SKILL.md）加载。例如：/char 你是一位温柔的图书馆管理员……',
          }
        }
        invocation.agent.session.append(CHARACTER_EVENT, { text: rest })
        applyCard(invocation.agent, rest)
        return {
          kind: 'success',
          text: `角色卡已导入（${rest.length} 字符）。从现在起我将严格遵循该设定。用 /status 查看状态，/reset 清除。`,
        }
      },
    })

    yield ctx.commands.register({
      name: 'memory',
      description: '记忆文件：/memory load <路径> 加载记忆，/memory clear 清除，/memory 查看状态',
      input: { hint: 'load <路径> | clear' },
      handler: async (invocation) => {
        const rest = invocation.rawInput.trim()
        const load = /^(?:load)\s+(.+)$/.exec(rest)
        if (load !== null) {
          const filePath = resolvePath(invocation.agent, load[1].trim())
          let raw
          try {
            raw = await readFile(filePath, 'utf8')
          } catch (error) {
            return {
              kind: 'error',
              text: `无法读取记忆文件 ${filePath}：${error instanceof Error ? error.message : String(error)}`,
            }
          }
          const text = raw.replace(/^\uFEFF/, '').trim()
          if (!text) {
            return { kind: 'error', text: `记忆文件 ${filePath} 内容为空。` }
          }
          invocation.agent.session.append(MEMORY_EVENT, { path: filePath, text })
          applyMemory(invocation.agent, filePath, text)
          return {
            kind: 'success',
            text: `记忆文件已加载：${filePath}（${text.length} 字符）。我会把扮演中的重要信息主动写入该文件，保持记忆持续更新。`,
          }
        }
        if (rest === 'clear') {
          clearMemory(invocation.agent)
          invocation.agent.session.append(MEMORY_EVENT, { clear: true })
          return { kind: 'success', text: '记忆区段已清除。用 /memory load <路径> 可重新加载。' }
        }
        const has = memorySections.has(invocation.agent.id)
        return {
          kind: 'success',
          text: has
            ? '当前已加载记忆文件。用 /memory clear 清除，或 /memory load <路径> 换一个。'
            : '尚未加载记忆文件。用 /memory load <路径> 加载你写的记忆文件（.md/.txt）。',
        }
      },
    })

    yield ctx.commands.register({
      name: 'reset',
      description: '清除当前角色卡，回到空容器状态',
      handler: (invocation) => {
        clearCard(invocation.agent)
        invocation.agent.session.append(CHARACTER_EVENT, { clear: true })
        return { kind: 'success', text: '角色卡已清除。我已回到空容器状态，等待新的设定。' }
      },
    })

    yield ctx.commands.register({
      name: 'roll',
      description: '掷骰子：/roll [数量]d[面数]（如 /roll、/roll 2d6、/roll d20+2）',
      input: { hint: '2d6' },
      handler: (invocation) => {
        const m = /^(\d*)d(\d+)(?:([+-])(\d+))?$/.exec(invocation.rawInput.trim())
        if (m === null) {
          return { kind: 'success', text: '用法：/roll [数量]d[面数][+/-修正]（如 /roll、/roll 2d6、/roll d20+2）。' }
        }
        const count = m[1] === '' ? 1 : Number(m[1])
        const sides = Number(m[2])
        if (count < 1 || count > 100) return { kind: 'error', text: '骰子数量需在 1–100 之间。' }
        if (sides < 2 || sides > 1000) return { kind: 'error', text: '骰子面数需在 2–1000 之间。' }
        const modifier = m[3] === undefined ? 0 : (m[3] === '+' ? 1 : -1) * Number(m[4] || 0)
        const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
        const sum = rolls.reduce((a, b) => a + b, 0)
        const total = sum + modifier
        const dicePart = `${count}d${sides}`
        const modPart = modifier === 0 ? '' : (modifier > 0 ? `+${modifier}` : String(modifier))
        const detail = rolls.length > 1 ? `（${rolls.join(' + ')}${modPart ? ` ${modPart}` : ''}）` : ''
        return { kind: 'success', text: `🎲 ${dicePart}${modPart}${detail} = ${total}` }
      },
    })

    yield ctx.commands.register({
      name: 'status',
      description: '查看当前角色卡与记忆状态',
      handler: (invocation) => {
        const hasCard = cardSections.has(invocation.agent.id)
        const hasMemory = memorySections.has(invocation.agent.id)
        const lines = []
        lines.push(hasCard ? '角色卡：已导入 ✓' : '角色卡：未导入（用 /char 导入，或 /char load <路径>）')
        lines.push(hasMemory ? '记忆文件：已加载 ✓（用 /memory clear 清除，/memory load <路径> 更换）' : '记忆文件：未加载（用 /memory load <路径> 加载你写的记忆）')
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  }, 'rp-commands lifecycle')
}
