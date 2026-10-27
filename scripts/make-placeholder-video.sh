#!/usr/bin/env bash
# S5 §5：用 ffmpeg 从现有背景图生成一段**占位**剧情视频。
#
#   b1_bg_main_v.png  --交叉淡入-->  b3_bg_closing_v.png   + 缓慢推镜
#
# 产物：apps/client/public/stage/videos/clip_ending.webm
#   · 约 6 秒、竖版 2:3（720×1080）、VP9、无音轨、体积 < 1.5MB
#
# 用法：bash scripts/make-placeholder-video.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

B1="${ROOT}/assets/raw/b1_bg_main_v.png"
B3="${ROOT}/assets/raw/b3_bg_closing_v.png"
OUT_DIR="${ROOT}/apps/client/public/stage/videos"
OUT="${OUT_DIR}/clip_ending.webm"

FPS=30
DURATION=6
WIDTH=720
HEIGHT=1080
FADE=1.5
OFFSET=4.5
MAX_BYTES=1572864 # 1.5MB

command -v ffmpeg >/dev/null 2>&1 || { echo "需要 ffmpeg（brew install ffmpeg）" >&2; exit 1; }
[ -f "$B1" ] || { echo "缺少素材：$B1" >&2; exit 1; }
[ -f "$B3" ] || { echo "缺少素材：$B3" >&2; exit 1; }
mkdir -p "$OUT_DIR"

FRAMES=$((DURATION * FPS))

# 两张图各自缓缓推近，再在中后段交叉淡入；单帧输入 + zoompan d=帧数 → 每张正好 DURATION 秒。
ffmpeg -y -hide_banner -loglevel error \
  -i "$B1" -i "$B3" \
  -filter_complex "\
[0:v]scale=${WIDTH}:${HEIGHT},setsar=1,zoompan=z='min(1+0.0006*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES}:s=${WIDTH}x${HEIGHT}:fps=${FPS}[a];\
[1:v]scale=${WIDTH}:${HEIGHT},setsar=1,zoompan=z='min(1+0.0006*on,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${FRAMES}:s=${WIDTH}x${HEIGHT}:fps=${FPS}[b];\
[a][b]xfade=transition=fade:duration=${FADE}:offset=${OFFSET},format=yuv420p[v]" \
  -map "[v]" -t "${DURATION}" \
  -c:v libvpx-vp9 -b:v 0 -crf 40 -row-mt 1 -cpu-used 4 -an \
  "$OUT"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
echo "wrote ${OUT} (${SIZE} bytes)"
if [ "$SIZE" -gt "$MAX_BYTES" ]; then
  echo "体积超过 1.5MB（${SIZE}），请调高 -crf" >&2
  exit 1
fi
