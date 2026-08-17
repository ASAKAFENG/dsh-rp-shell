# dsh-rp-shell · 角色扮演 · RP Shell

一个面向 **DeepSeek Harness 插件市场**的开源 AGENT 预设插件：**空容器角色扮演 Agent**。

> 「容器」是核心设计：本插件**不携带任何内置人格**。你扮演谁、有什么性格、世界观、
> 能力与限制——全部由你在对话中导入的**角色卡（Character Card）**定义。
> 预设本身不附加设定之外的额外限制，一切以导入的设定与你的指令为准。

---

## 特性

- **零内置人格**：没有预设性格/背景/价值观，是纯粹的扮演容器。
- **严格遵循导入设定**：`/char` 导入角色卡后，系统提示词区段按会话注入，模型每次请求都严格遵循（会话恢复后自动重放，设定不丢）。
- **不附加额外限制**：预设不添加设定之外的道德说教或行为限制；边界完全由导入的设定与用户指令定义。
- **命令 + 工具交互**：
  - `/char <角色卡>` — 导入角色设定
  - `/roll [数量]d[面数][+/-修正]` — 掷骰子（如 `/roll 2d6`、`/roll d20+2`）
  - `/reset` — 清除角色卡，回到空容器
  - `/status` — 查看当前角色状态
  - 完整工具面：Shell、文件读写/检索、网页检索、询问用户、待办、后台任务、Skills、压缩
- **严格遵守用户指令**：用户指令优先于默认行为；OOC（Out Of Character）随时可切换。

## 快速开始

### 方式一：本地安装（开发/自用）

```bash
git clone <your-repo-url> dsh-rp-shell
cd dsh-rp-shell
bash scripts/build.sh          # 语法检查 + 链接运行时依赖 + 打包 tgz
bash scripts/install.sh        # 装配进 DSH profile（默认 web）
```

重启 DSH，新开会话，在**预设选择器**中选择「角色扮演 · RP Shell」。

### 方式二：从 GitHub Release 安装

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/dsh-rp-shell/main/scripts/install.sh | bash -s -- --github
```

### 方式三：插件市场安装

发布 Release 后，在 DSH 插件市场搜索 `dsh-rp-shell` 一键安装。

## 使用示例

```
你：/char 你叫「铃」，是一名 17 岁的见习图书管理员。性格温柔害羞，说话轻声细语，
    口头禅是"那个……"。梦想是修好图书馆顶楼的星象仪。当有人问起星空时你会变得
    格外兴奋。你不记得图书馆之外的任何事，如果有人问起，你会困惑地摇头。

你：晚上好呀，今天图书馆里有什么有趣的事吗？
铃：那个……晚上好！今天的话，有一本会发光的童话书自己从书架上飞了下来，
    我花了好久才把它哄回去……啊，抱歉，是不是说得太多了？

你：/roll 2d6
🎲 2d6（3 + 5）= 8
```

OOC 示例：`（OOC：现在切换到现代都市背景）` — Agent 会遵循你的新指令。

## 设计说明

- **预设组成**（`preset/rp-shell/agent.cordis.yml`）：空容器 persona + 完整工具面 + 压缩组。
- **命令插件**（`preset/rp-shell/rp-commands.mjs`）：`/char` 把角色卡写入持久会话事件 `rp/character`，并注入 per-agent 系统提示词区段；`agent/session-start` 时自动重放，重启不丢。
- **bundle 层**（`lib/index.js` + `cordis.patch.yml`）：幂等安装/升级预设到 `$DSH_HOME/.agent-presets/rp-shell/`（同版本跳过、不同版本备份后升级），预设目录用户可手工编辑。

## 开源到插件市场

1. **建仓**：创建 GitHub 仓库（如 `<owner>/dsh-rp-shell`），把本目录推上去（记得把 `package.json` 的 `repository.url` 与 `scripts/install.sh` 里的 `REPO` 改成你的仓库）。
2. **构建**：`bash scripts/build.sh` 产出 `dist/dsh-external-dsh-rp-shell-<version>.tgz`。
3. **发版**：用 `gh release create v<version> dist/*.tgz` 发布（附 tgz 资产）。
4. **上市场**：在 DSH 插件市场提交/收录你的仓库（`@dsh-external/dsh-rp-shell` 类型为 `cordis-plugin`，自带 `agent-preset` 安装器）；给仓库打 `dsh-plugin` / `deepseek-harness` topic 便于检索。
5. **迭代**：改 `preset/` 或 `lib/` → bump `package.json` version → 重新 build + release。

## 许可

MIT — 见 [LICENSE](./LICENSE)。
