// dsh-rp-shell — 空容器角色扮演 Agent 预设插件。
//
// 两个挂载面：
//  1. HOST 面（bundle 层，config.installPreset=true）：把随包的 `rp-shell`
//     agent 预设安装进 $DSH_HOME/.agent-presets/rp-shell/（幂等、可升级、
//     用户可编辑），让会话选择器出现该预设。
//  2. PRESET 面（preset/rp-shell/ 内的组成）：agent.cordis.yml 注册工具与
//     提示词区段，rp-commands.mjs 注册 /char /reset /roll /status 命令并
//     把角色卡注入 per-agent 系统提示词。仅对选用该预设的会话生效。
//
// 零 npm 运行时依赖（仅 node 内置模块）。
//
// ESM 模块格式（cordis bundle 规则）：具名导出 apply/inject/name。
import { readFile, stat, mkdir, writeFile, cp, rm, rename } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/** Cordis 插件名。 */
const name = "rp-shell";
/** 安装器挂在 host 面即可，无需注入服务。 */
const inject = [];

/** 随包安装的预设 id（目录名）。 */
const PRESET_ID = "rp-shell";
/** 预设目录内版本标记文件名。 */
const VERSION_MARKER = "VERSION";

// ────────────────────────────────────────────────────────────────────────────
// 配置
// ────────────────────────────────────────────────────────────────────────────

const Config = z.object({
  /** host 面：安装/升级随包的 agent 预设（幂等）。 */
  installPreset: z.boolean().default(false),
});

// ────────────────────────────────────────────────────────────────────────────
// 安装器
// ────────────────────────────────────────────────────────────────────────────

/** 随包 preset 源目录（本文件在 lib/ 下，源在 ../preset/）。 */
function presetSourceDir() {
  return fileURLToPath(new URL("../preset/", import.meta.url));
}

/** $DSH_HOME（默认 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 包版本（读 package.json，读不到视为 0.0.0）。 */
function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 安装审计（落盘到 $DSH_HOME，便于排查"预设没出现"类问题）。 */
function auditInstall(msg) {
  try {
    fs.appendFileSync(path.join(dshHome(), "rp-shell-install.log"),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

/** 幂等安装/升级 preset；返回 'installed' | 'upgraded' | 'unchanged' | 'skipped'。 */
async function installPreset(ctx) {
  const src = path.join(presetSourceDir(), PRESET_ID);
  auditInstall(`install begin (src=${src}, home=${dshHome()})`);
  const srcOk = await stat(path.join(src, "agent.cordis.yml")).catch(() => null);
  if (!srcOk) {
    ctx.logger.warn(`[rp-shell] preset source missing: ${src}`);
    return "skipped";
  }
  const destRoot = path.join(dshHome(), ".agent-presets");
  const dest = path.join(destRoot, PRESET_ID);
  const version = packageVersion();
  const markerPath = path.join(dest, VERSION_MARKER);
  const existing = await stat(dest).catch(() => null);
  if (existing) {
    let currentVersion = null;
    try {
      currentVersion = (await readFile(markerPath, "utf8")).trim();
    } catch {
      /* 无标记：视为旧版或用户自建 */
    }
    if (currentVersion === version) {
      return "unchanged";
    }
    // 版本不同（或旧版无标记）：把旧目录整体改名保留（含用户可能的手工修改），
    // 再安装新版本。
    const backup = `${dest}.bak-${Date.now()}`;
    await rm(backup, { recursive: true, force: true });
    await rename(dest, backup);
    ctx.logger.info(`[rp-shell] upgrading preset (was ${currentVersion ?? "unmarked"}, now ${version}); previous copy kept at ${backup}`);
    auditInstall(`upgrade: ${currentVersion ?? "unmarked"} -> ${version}`);
  } else {
    await mkdir(destRoot, { recursive: true });
  }
  await cp(src, dest, { recursive: true });
  await writeFile(markerPath, version + "\n", { mode: 0o600 });
  ctx.logger.info(`[rp-shell] agent preset installed: ${dest} (v${version})`);
  auditInstall(`installed: ${dest} (v${version})`);
  return existing ? "upgraded" : "installed";
}

// ────────────────────────────────────────────────────────────────────────────
// 插件入口
// ────────────────────────────────────────────────────────────────────────────

/** 插件挂载面：任何挂载面都幂等安装/升级随包预设。 */
async function apply(ctx, config) {
  if (config.installPreset !== false) {
    try {
      const result = await installPreset(ctx);
      if (result !== "unchanged") {
        ctx.logger.info(`[rp-shell] preset ${result} — 新开会话即可在预设选择器中选用「角色扮演 · RP Shell」`);
      }
    } catch (error) {
      ctx.logger.error(`[rp-shell] preset install failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // 命令 / 工具 / 提示词区段全部在 PRESET 面（preset/rp-shell/agent.cordis.yml），
  // 由 dsh-agent-presets 按会话挂载；bundle 层不注册任何模型面能力。
}

export { Config, apply, inject, name };
