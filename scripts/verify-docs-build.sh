#!/usr/bin/env bash
# S6d-fix1：构建验证 —— 撤回 root 上移后，入口 HTML 必须回到 dist 根目录，
# 且每篇文档仍是独立 chunk（虚拟模块 + 动态 import）。
#
# 用法：bash scripts/verify-docs-build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DIST="${ROOT}/apps/client/dist"

cd "$ROOT"
pnpm --filter @mira/client build >/dev/null

[ -f "${DIST}/index.html" ] || { echo "FAIL: 缺少 ${DIST}/index.html（入口 HTML 不在 dist 根目录）" >&2; exit 1; }

# 文档 chunk 的文件名取自文档名（如 decisions-*.js、s6a-report-*.js）。
DOC_CHUNKS=$(ls "${DIST}/assets/" | grep -E '^(decisions|roadmap|s6a-report|.*-report|prompt\.v1|scene\.v1|ai-usage-log|README|AI_USAGE)-.*\.js$' || true)
[ -n "$DOC_CHUNKS" ] || { echo "FAIL: ${DIST}/assets 里没有任何文档 chunk" >&2; exit 1; }

# 主入口 chunk 不应包含文档正文（保持按需加载）。
MAIN_CHUNK=$(ls "${DIST}/assets/index-"*.js | head -1)
if grep -q "架构决策记录" "$MAIN_CHUNK"; then
  echo "FAIL: 主入口 chunk 包含了文档正文（按需加载失效）" >&2
  exit 1
fi

echo "OK: ${DIST}/index.html 存在；文档 chunk："
echo "$DOC_CHUNKS" | sed 's/^/  - /'
