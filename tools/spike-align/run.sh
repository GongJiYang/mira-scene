#!/usr/bin/env bash
# 探针 P4: 一条命令跑完配准 + 贴片 + 桌面抠图, 然后打印预览页启动方式。
# 只在 tools/spike-align/.venv 里装依赖, 不碰仓库其余部分。
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
VENV="$ROOT/tools/spike-align/.venv"
PY="$VENV/bin/python"

if [ ! -x "$PY" ]; then
  echo "[1/3] 建 venv: tools/spike-align/.venv"
  python3 -m venv "$VENV"
else
  echo "[1/3] venv 已存在, 复用 tools/spike-align/.venv"
fi

echo "[2/3] 检查依赖 (opencv-python-headless, numpy)"
if ! "$PY" -c "import cv2, numpy" >/dev/null 2>&1; then
  "$PY" -m pip install --quiet --upgrade pip
  "$PY" -m pip install --quiet opencv-python-headless numpy
fi
"$PY" -c "import cv2, numpy; print('      cv2', cv2.__version__, '/ numpy', numpy.__version__)"

echo "[3/3] 去色边 + 两阶段配准 + 贴片 + 桌面抠图"
"$PY" "$ROOT/tools/spike-align/align.py"

echo
echo "产物: assets/parts/master_clean.png + 14 张表情/手势 1024x1536 RGBA + 1 张桌面 1024x1024 RGBA"
echo "数值: tools/spike-align/metrics.json (预览页读同名的 metrics.js)"
echo "约束: tools/spike-align/composition.json (characterClipBottom / tableTopMinCover)"
echo
echo "预览页启动方式 (必须在仓库根目录起 httpserver, 否则读不到 assets/parts/):"
echo "    cd \"$ROOT\" && python3 -m http.server 8000"
echo "    然后打开 http://localhost:8000/tools/spike-align/preview.html"
echo
echo "竖屏手机: 同一局域网内用 http://<本机IP>:8000/tools/spike-align/preview.html"
