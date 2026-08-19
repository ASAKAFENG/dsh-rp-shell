#!/bin/bash
# dsh-rp-shell 一键安装脚本
#
# 把插件完整装配进一个 DSH profile（bundle 注册 + 预设安装），重启后生效。
#
# 用法：
#   本地模式（从克隆/解压的包目录安装）：
#     bash scripts/install.sh
#
#   远程模式（直接从 GitHub Release 下载安装，无需克隆仓库）：
#     bash scripts/install.sh --github
#     或一条命令：
#     curl -fsSL https://raw.githubusercontent.com/ASAKAFENG/dsh-rp-shell/main/scripts/install.sh | bash -s -- --github
#
# 可选参数：
#   --profile <name>   目标 profile 名（默认 web，可用环境变量 DSH_RP_SHELL_PROFILE 覆盖）
#   --version <ver>    远程模式指定版本号（默认 latest）
#   --force            预设已存在时强制覆盖（默认：同版本跳过、不同版本备份后升级）
#   --dry-run          只打印将要执行的操作，不写入
#
# 幂等：重复执行安全——已注册的 bundle/依赖/预设自动跳过。
set -euo pipefail

# ── 常量 ─────────────────────────────────────────────────────────────────────
REPO="${DSH_RP_SHELL_REPO:-ASAKAFENG/dsh-rp-shell}"
PKG_NAME="@dsh-external/dsh-rp-shell"
PRESET_ID="rp-shell"
VERSION_MARKER="VERSION"

# ── 参数解析 ─────────────────────────────────────────────────────────────────
PROFILE="${DSH_RP_SHELL_PROFILE:-web}"
MODE="local"
VERSION="latest"
FORCE=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --github) MODE="remote" ;;
    --profile) PROFILE="${2:?--profile 需要参数}"; shift ;;
    --version) VERSION="${2:?--version 需要参数}"; shift ;;
    --force) FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── 环境探测 ─────────────────────────────────────────────────────────────────
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
PROFILE_PKG="$PROFILE_DIR/package.json"
if [ ! -f "$PROFILE_PKG" ]; then
  echo "install: profile 不存在: $PROFILE_PKG（可用 --profile 指定其他 profile）" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "install: 需要 node（DSH 运行时自带）" >&2
  exit 1
fi

# 版本标记读取（预设目录里）
read_marker() {
  if [ -f "$1/$VERSION_MARKER" ]; then cat "$1/$VERSION_MARKER"; else echo ""; fi
}

# ── 0. 下载函数（多源 fallback + 超时）────────────────────────────────────
download_tgz() {
  local out="$1"; shift
  local last_err=""
  for url in "$@"; do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSL --max-time 120 --connect-timeout 15 -o "$out" "$url" 2>/dev/null; then
        echo "$url"; return 0
      fi
      last_err="curl: $url"
    else
      if node -e "fetch('$url',{signal:AbortSignal.timeout(120000)}).then(async r=>{if(!r.ok)process.exit(1);require('node:fs').writeFileSync(process.argv[1],Buffer.from(await r.arrayBuffer()))},()=>process.exit(1)).catch(()=>process.exit(1))" "$out" 2>/dev/null; then
        echo "$url"; return 0
      fi
      last_err="node-fetch: $url"
    fi
  done
  echo "install: 所有下载源均失败（$last_err）。可设置 DSH_RP_SHELL_TGZ_URL 指定镜像/代理地址后重试。" >&2
  return 1
}

# ── 1. 获取包内容 ────────────────────────────────────────────────────────────
PKG_DIR=""
if [ "$MODE" = "local" ]; then
  PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  if [ ! -f "$PKG_DIR/package.json" ] || [ ! -d "$PKG_DIR/preset/rp-shell" ]; then
    echo "install: 本地包目录不完整（缺 package.json 或 preset/rp-shell）: $PKG_DIR" >&2
    echo "install: 若想从 GitHub 安装，请用: bash scripts/install.sh --github" >&2
    exit 1
  fi
  if [ ! -f "$PKG_DIR/lib/index.js" ]; then
    echo "install: 本地模式需要已构建的 lib/index.js——请先构建（bash scripts/build.sh），或改用 --github 从 Release 安装" >&2
    exit 1
  fi
  echo "install: 本地模式，包目录 = $PKG_DIR"
elif [ "$MODE" = "remote" ]; then
  echo "install: 远程模式，从 $REPO 下载 v$VERSION"
  TGZ_URLS=()
  if [ "$VERSION" = "latest" ]; then
    API_URL="https://api.github.com/repos/$REPO/releases/latest"
    API_RESULT=""
    if command -v curl >/dev/null 2>&1; then
      API_RESULT="$(curl -fsSL --max-time 20 --connect-timeout 10 "$API_URL" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=JSON.parse(s);const a=(r.assets??[]).find(x=>x.name.endsWith('.tgz'));if(!a)process.exit(1);console.log(a.browser_download_url+'\n'+a.name)}catch{process.exit(1)}})" || true)"
    else
      API_RESULT="$(node -e "fetch('$API_URL',{signal:AbortSignal.timeout(20000)}).then(r=>r.json()).then(r=>{const a=(r.assets??[]).find(x=>x.name.endsWith('.tgz'));if(!a)process.exit(1);console.log(a.browser_download_url+'\n'+a.name)}).catch(()=>process.exit(1))" || true)"
    fi
    if [ -n "$API_RESULT" ]; then
      API_URL_DL="$(printf '%s' "$API_RESULT" | sed -n 1p)"
      TGZ_NAME="$(printf '%s' "$API_RESULT" | sed -n 2p)"
      TGZ_URLS=("$API_URL_DL" "https://raw.githubusercontent.com/$REPO/main/dist/$TGZ_NAME")
    else
      echo "install: 无法解析最新 release 资产（API 不可达或限流），尝试仓库内 dist/ 镜像"
      TGZ_URLS=("https://raw.githubusercontent.com/$REPO/main/dist/dsh-external-dsh-rp-shell-latest.tgz")
    fi
  else
    TGZ_NAME="dsh-external-dsh-rp-shell-${VERSION#v}.tgz"
    TGZ_URLS=(
      "https://github.com/$REPO/releases/download/v${VERSION#v}/$TGZ_NAME"
      "https://raw.githubusercontent.com/$REPO/main/dist/$TGZ_NAME"
    )
  fi
  if [ -n "${DSH_RP_SHELL_TGZ_URL:-}" ]; then
    TGZ_URLS=("$DSH_RP_SHELL_TGZ_URL")
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "install: 下载 ${TGZ_URLS[0]}"
  if ! download_tgz "$TMP/pkg.tgz" "${TGZ_URLS[@]}"; then
    exit 1
  fi
  tar -xzf "$TMP/pkg.tgz" -C "$TMP"
  PKG_DIR="$TMP/package"
  if [ ! -f "$PKG_DIR/package.json" ] || [ ! -d "$PKG_DIR/preset/rp-shell" ]; then
    echo "install: 下载的包内容不完整" >&2
    exit 1
  fi
fi

PKG_VERSION="$(node -e "console.log(require('$PKG_DIR/package.json').version)")"
echo "install: 包版本 = v$PKG_VERSION"

# ── 2. 装配进 profile（bundle 注册，幂等）───────────────────────────────────
SCOPE_DIR="$PROFILE_DIR/node_modules/@dsh-external"
DEST_DIR="$SCOPE_DIR/dsh-rp-shell"

plan_lines=""
if [ "$MODE" = "local" ]; then
  plan_lines="+ dependencies: $PKG_NAME = link:$PKG_DIR"
  plan_lines="$plan_lines
+ node_modules junction: $DEST_DIR -> $PKG_DIR"
else
  plan_lines="+ 解压包到: $DEST_DIR"
  plan_lines="$plan_lines
+ dependencies: $PKG_NAME = file:$DEST_DIR"
fi
plan_lines="$plan_lines
+ dsh.profile.bundles += $PKG_NAME"

if [ "$DRY" = "1" ]; then
  echo "── 将要执行（--dry-run）──"
  echo "$plan_lines"
  echo "── 预设安装 ──"
  PRESET_DEST="$DSH_HOME_DIR/.agent-presets/$PRESET_ID"
  if [ -d "$PRESET_DEST" ]; then
    cur="$(read_marker "$PRESET_DEST")"
    if [ "$cur" = "$PKG_VERSION" ]; then
      echo "（跳过：预设已是最新 v$PKG_VERSION）"
    else
      echo "（备份 $PRESET_DEST -> $PRESET_DEST.bak-<时间戳> 后替换为 v$PKG_VERSION）"
    fi
  else
    echo "（复制 preset -> $PRESET_DEST）"
  fi
  echo "── 完成。重启 DSH 后 bundle 装配生效 ──"
  exit 0
fi

# 解压/链接包目录
if [ "$MODE" = "remote" ]; then
  mkdir -p "$SCOPE_DIR"
  DEST_VER=""
  if [ -f "$DEST_DIR/package.json" ]; then
    DEST_VER="$(node -e "try{console.log(require('$DEST_DIR/package.json').version)}catch{console.log('')}")"
  fi
  if [ -n "$DEST_VER" ] && [ "$DEST_VER" = "$PKG_VERSION" ]; then
    echo "install: 包目录已是最新 v$PKG_VERSION（跳过解压）"
  else
    if [ -e "$DEST_DIR" ]; then
      mv "$DEST_DIR" "$DEST_DIR.bak-$(date +%s)"
      echo "install: 旧包目录已备份"
    fi
    cp -R "$PKG_DIR" "$DEST_DIR"
    chmod -R u+rwX,go-rwx "$DEST_DIR"
    echo "install: 包已解压到 $DEST_DIR"
  fi
else
  mkdir -p "$SCOPE_DIR"
  if [ -e "$DEST_DIR" ] && [ ! -L "$DEST_DIR" ]; then
    mv "$DEST_DIR" "$DEST_DIR.bak-$(date +%s)"
    echo "install: 旧包目录已备份"
  fi
  rm -rf "$DEST_DIR"
  ln -sfn "$PKG_DIR" "$DEST_DIR"
  echo "install: node_modules 链接已建立: $DEST_DIR"
fi

# 编辑 profile package.json（dependencies + bundles，幂等）
node - "$PROFILE_PKG" "$PKG_NAME" "$MODE" "$PKG_DIR" "$DEST_DIR" <<'NODE'
const [pkgPath, pkgName, mode, localDir, destDir] = process.argv.slice(2);
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const changed = [];
pkg.dependencies = pkg.dependencies ?? {};
const depValue = mode === "local" ? `link:${localDir}` : `file:${destDir}`;
if (!pkg.dependencies[pkgName]) {
  pkg.dependencies[pkgName] = depValue;
  changed.push(`dependencies.${pkgName} = ${depValue}`);
}
pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? [];
if (!pkg.dsh.profile.bundles.includes(pkgName)) {
  pkg.dsh.profile.bundles.push(pkgName);
  changed.push(`bundles += ${pkgName}`);
}
if (changed.length > 0) {
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
}
console.log(changed.length > 0 ? changed.join("\n") : "（profile 已注册，跳过）");
NODE

# ── 3. 安装预设（幂等/备份升级）──────────────────────────────────────────────
PRESET_DEST="$DSH_HOME_DIR/.agent-presets/$PRESET_ID"
SRC_PRESET="$PKG_DIR/preset/rp-shell"
if [ -d "$PRESET_DEST" ]; then
  cur="$(read_marker "$PRESET_DEST")"
  if [ "$cur" = "$PKG_VERSION" ]; then
    echo "install: 预设已是最新 v$PKG_VERSION（跳过）"
  else
    if [ "$FORCE" = "1" ]; then
      rm -rf "$PRESET_DEST"
      echo "install: 旧预设已移除（--force）"
    else
      mv "$PRESET_DEST" "$PRESET_DEST.bak-$(date +%s)"
      echo "install: 旧预设已备份（v${cur:-未知} -> .bak-<时间戳>）"
    fi
    cp -R "$SRC_PRESET" "$PRESET_DEST"
    chmod -R u+rwX,go-rwx "$PRESET_DEST"
    echo "$PKG_VERSION" > "$PRESET_DEST/$VERSION_MARKER"
    echo "install: 预设已更新为 v$PKG_VERSION"
  fi
else
  mkdir -p "$(dirname "$PRESET_DEST")"
  cp -R "$SRC_PRESET" "$PRESET_DEST"
  chmod -R u+rwX,go-rwx "$PRESET_DEST"
  echo "$PKG_VERSION" > "$PRESET_DEST/$VERSION_MARKER"
  echo "install: 预设已安装到 $PRESET_DEST"
fi

# ── 4. 完成 ──────────────────────────────────────────────────────────────────
echo ""
echo "✔ dsh-rp-shell v$PKG_VERSION 装配完成（profile: $PROFILE）"
echo "  1. 重启 DSH（bundle 由 dsh.profile.bundles 自动装配）"
echo "  2. 新开会话，在预设选择器中选择「角色扮演 · RP Shell」"
echo "  3. 用 /char 导入角色卡开始扮演；/roll 掷骰子；/reset 清除；/status 查看状态"
echo "  4. 若预设未出现，查看 $DSH_HOME_DIR/rp-shell-install.log"
echo "卸载: 从 $PROFILE_PKG 移除 bundles/dependencies 条目，删除 $DEST_DIR 与 $PRESET_DEST"
