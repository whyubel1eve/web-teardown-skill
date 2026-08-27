#!/usr/bin/env bash
# web-teardown · 安装脚本
#
#   ./install.sh                      # 自动探测 agent 技能目录
#   ./install.sh ~/my-agent/skills    # 装到指定目录
#   WEB_TEARDOWN_DIR=... ./install.sh # 用环境变量指定
#
# 这个 skill 不绑定任何特定 agent。下面探测的是常见 agent 的技能目录，
# 探测不到也没关系 —— 装到任何目录都能用，只要你的 agent 能读到那个目录里的文件。

set -euo pipefail

NAME="web-teardown"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say() { printf "%s\n" "$*"; }

# ── 1. 装到哪 ──────────────────────────────────────────────────
# 优先级：命令行参数 > 环境变量 > 探测到的已有 agent 目录 > 当前目录
TARGET_PARENT="${1:-${WEB_TEARDOWN_DIR:-}}"

if [ -z "$TARGET_PARENT" ]; then
  # 只认已经存在的目录 —— 探测不到就不猜，猜错会把文件装到没人读的地方。
  # 覆盖面按常见程度排：Claude Code / Codex / 通用 .agents / OpenCode / Cursor / Gemini / Cline
  for d in \
    "$HOME/.claude/skills" \
    "$HOME/.config/claude/skills" \
    "$HOME/.codex/skills" \
    "$HOME/.agents/skills" \
    "$HOME/.opencode/skills" \
    "$HOME/.config/opencode/skills" \
    "$HOME/.cursor/skills" \
    "$HOME/.gemini/skills" \
    "$HOME/.cline/skills" \
    "$(pwd)/.claude/skills" \
    "$(pwd)/.agents/skills" ; do
    if [ -d "$d" ]; then TARGET_PARENT="$d"; break; fi
  done
fi

if [ -z "$TARGET_PARENT" ]; then
  TARGET_PARENT="$(pwd)"
  say "${YELLOW}没探测到已知的 agent 技能目录，装到当前目录。${OFF}"
  say "${DIM}你的 agent 如果有专门的技能/规则目录，用 ./install.sh <目录> 指定。${OFF}"
fi

DEST="$TARGET_PARENT/$NAME"
say "${BLUE}安装位置${OFF}  $DEST"

# ── 2. 放文件 ──────────────────────────────────────────────────
if [ "$SRC" = "$DEST" ]; then
  say "${DIM}已经在目标位置，跳过复制。${OFF}"
else
  if [ -e "$DEST" ]; then
    say "${YELLOW}$DEST 已存在${OFF} —— 先移走或换个目录，避免覆盖你改过的内容。"; exit 1
  fi
  mkdir -p "$TARGET_PARENT"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude '.git' --exclude 'node_modules' "$SRC/" "$DEST/"
  else
    cp -R "$SRC" "$DEST"
    rm -rf "$DEST/.git"
  fi
fi
chmod +x "$DEST/scripts/"*.mjs 2>/dev/null || true
say "${GREEN}✓${OFF} 文件就位"

# ── 3. 依赖检查 ────────────────────────────────────────────────
# 全都是可选的：三条采集通道里最后一条零依赖，什么都没有也能用。
say ""
say "${DIM}依赖检查（全部可选）${OFF}"

NODE_OK=0; NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    say "  ${GREEN}✓${OFF} Node $(node -v)  ${DIM}三条通道全可用${OFF}"; NODE_OK=2
  else
    say "  ${YELLOW}○${OFF} Node $(node -v)  ${DIM}分析和渲染可用；通道 C 需要 ≥22（global WebSocket）${OFF}"; NODE_OK=1
  fi
else
  say "  ${YELLOW}○${OFF} 没有 Node  ${DIM}只能走通道 A（控制台粘贴），采到的数据交给 agent 直接分析${OFF}"
fi

CHROME=""
for p in "${CHROME_PATH:-}" \
         "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
         "/usr/bin/google-chrome" "/usr/bin/chromium" "/usr/bin/chromium-browser"; do
  [ -n "${p:-}" ] && [ -x "$p" ] && { CHROME="$p"; break; }
done
if [ -n "$CHROME" ]; then
  say "  ${GREEN}✓${OFF} Chrome  ${DIM}${CHROME}${OFF}"
else
  say "  ${YELLOW}○${OFF} 没找到 Chrome  ${DIM}通道 C 不可用；装了之后可用 CHROME_PATH 指定${OFF}"
fi

# ── 4. 自检 ────────────────────────────────────────────────────
if [ "$NODE_OK" -ge 1 ]; then
  say ""
  say "${DIM}自检：跑一遍分析和渲染…${OFF}"
  TMP="$(mktemp -d)"
  if node "$DEST/scripts/selftest.mjs" "$TMP" >/dev/null 2>&1; then
    say "${GREEN}✓${OFF} 分析 + 渲染管线正常"
  else
    say "${YELLOW}✗ 自检没通过${OFF} —— 手动跑一次看报错："
    say "  ${DIM}node $DEST/scripts/selftest.mjs${OFF}"
  fi
  rm -rf "$TMP"
fi

# ── 5. 下一步 ──────────────────────────────────────────────────
say ""
say "${GREEN}装好了。${OFF}"
say ""
say "给 agent 看的："
say "  ${BLUE}1${OFF} 读 ${DEST}/SKILL.md —— 流程和 references/ 的路由"
say "  ${BLUE}2${OFF} 按需读 references/ 下的三份参考"
say ""
if [ "$NODE_OK" -ge 2 ] && [ -n "$CHROME" ]; then
  say "${DIM}试一下：${OFF}"
  say "  ${DIM}node $DEST/scripts/teardown.mjs linear.app --out td.json${OFF}"
  say "  ${DIM}node $DEST/scripts/analyze.mjs td.json --out an.json${OFF}"
  say "  ${DIM}node $DEST/scripts/report.mjs an.json --out teardown.html${OFF}"
else
  say "${DIM}用法举例：「扒一下 linear.app 的设计系统」${OFF}"
fi
