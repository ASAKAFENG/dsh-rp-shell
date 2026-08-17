/**
 * rp-commands: 角色扮演（RP Shell）预设的命令与角色卡注入插件。
 *
 * 职责：
 *  1. 注册 `/char` `/reset` `/roll` `/status` 四个命令（写入 `commands` 注册表，
 *     对本预设挂载的所有会话可见）。
 *  2. `/char <角色卡>`：把角色卡文本 append 为持久会话事件（`rp/character`），
 *     并通过 `agent.ctx.systemPrompt.section()` 注入为 per-agent 系统提示词区段，
 *     使模型在每次请求中都严格遵循该设定。命令本身是 log-only，不进入对话表面。
 *  3. `/reset`：清除当前角色卡区段并记录清除事件。
 *  4. 会话启动/恢复（`agent/session-start`）时，从会话日志重放最后一条
 *     `rp/character` 事件，角色卡在重启/恢复后依然生效。
 *
 * 零外部依赖：相对 preset 行从用户 home 解析 bare specifier（那里没有安装
 * `@deepseek-ai/*`），因此本文件只用注入的服务，不 import 任何包。
 */

/** Cordis 插件名，供 loader 诊断使用。 */
export const name = 'rp-commands'

/** 命令注册表必须在场；systemPrompt 通过 `invocation.agent.ctx` 访问。 */
export const inject = ['commands']

/** 角色卡持久事件的会话事件类型（非 surface，不进入模型对话表面）。 */
const CHARACTER_EVENT = 'rp/character'

/** 系统提示词区段名与排序：紧跟 persona（order 0）之后。 */
const CARD_SECTION = 'rp:character-card'
const CARD_ORDER = 1

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

export function apply(ctx) {
  /** sessionId -> 当前角色卡区段的 disposer。 */
  const sections = new Map()

  /** 为指定 agent 注入角色卡区段（先移除旧区段）。 */
  function applyCard(agent, text) {
    const old = sections.get(agent.id)
    if (old) old()
    const dispose = agent.ctx.systemPrompt.section({
      name: CARD_SECTION,
      order: CARD_ORDER,
      text: cardSectionText(text),
    })
    sections.set(agent.id, dispose)
  }

  /** 清除指定 agent 的角色卡区段。 */
  function clearCard(agent) {
    const old = sections.get(agent.id)
    if (old) {
      old()
      sections.delete(agent.id)
    }
  }

  // ── 会话启动/恢复：重放最后一条角色卡事件 ────────────────────────────────
  ctx.on('agent/session-start', ({ agent }) => {
    let card = null
    for (const event of agent.session.events) {
      if (event.type !== CHARACTER_EVENT) continue
      card = event.data
    }
    if (card === null) return
    if (card.clear) clearCard(agent)
    else if (typeof card.text === 'string') applyCard(agent, card.text)
  })

  // agent 销毁时清理其区段（disposer 本身已随 agent.ctx 卸载，此处兜底）。
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = sections.get(agent.id)
    if (dispose) {
      dispose()
      sections.delete(agent.id)
    }
  })

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'char',
      description: '导入角色卡：/char <角色卡内容>（将严格遵循该设定）',
      input: { hint: '角色卡内容' },
      handler: (invocation) => {
        const text = invocation.rawInput.trim()
        if (!text) {
          return {
            kind: 'error',
            text: '用法：/char <角色卡内容>。例如：/char 你是一位温柔的图书馆管理员……（也可直接粘贴设定到对话中，我会同样严格遵循。）',
          }
        }
        invocation.agent.session.append(CHARACTER_EVENT, { text })
        applyCard(invocation.agent, text)
        return {
          kind: 'success',
          text: `角色卡已导入（${text.length} 字符）。从现在起我将严格遵循该设定。用 /status 查看状态，/reset 清除。`,
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
      description: '查看当前角色卡状态',
      handler: (invocation) => {
        const has = sections.has(invocation.agent.id)
        return {
          kind: 'success',
          text: has
            ? '当前已导入角色卡，处于角色扮演状态。'
            : '当前为空容器状态，尚未导入角色卡（用 /char 导入，或直接在对话中提供设定）。',
        }
      },
    })
  }, 'rp-commands lifecycle')
}
