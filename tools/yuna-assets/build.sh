#!/usr/bin/env bash
#
# 忧奈 Live2D 资源构建（S6a §1.1）。
#
# 从源目录（只读）生成到 apps/client/public/models/yuna/：
#   - 只拷贝 moc3 / model3.json / physics3.json / cdi3.json / 贴图；
#   - 全部改成 ASCII 名，并同步改写 yuna.model3.json 里的引用；
#   - 贴图只出 2048×2048 一个版本（64×64 那张原样拷贝）；
#   - 水印参数 Param1–Param10 保持原样，不去掉（D38）。
#
# 可重复运行：先清空输出目录再重建。源目录绝不写入。
set -euo pipefail

SRC_DEFAULT="/Users/gjy/tools/models/yuna/1969791368779464706-2019769674690473986-忧奈_processed.enc"
SRC="${1:-$SRC_DEFAULT}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/apps/client/public/models/yuna"

TEXTURE_SIZE=2048

if [[ ! -d "$SRC" ]]; then
  echo "源目录不存在：$SRC" >&2
  exit 1
fi

# 贴图文件名里的「漠.8192」前缀在源目录里是纹理子目录名；输出统一用 textures/。
SRC_TEXTURES="$SRC/漠.8192"

for required in 漠.moc3 漠.model3.json 漠.physics3.json 漠.cdi3.json; do
  if [[ ! -f "$SRC/$required" ]]; then
    echo "缺少源文件：$SRC/$required" >&2
    exit 1
  fi
done
if [[ ! -d "$SRC_TEXTURES" ]]; then
  echo "缺少贴图目录：$SRC_TEXTURES" >&2
  exit 1
fi

# 输出目录每次重建，保证可重复。
rm -rf "$OUT"
mkdir -p "$OUT/textures"

copy() { # copy <src> <dst>
  cp -p "$1" "$2"
}

echo "源目录（只读）：$SRC"
echo "输出目录：$OUT"

# 模型与配置：改名拷贝。
copy "$SRC/漠.moc3" "$OUT/yuna.moc3"
copy "$SRC/漠.physics3.json" "$OUT/yuna.physics3.json"
copy "$SRC/漠.cdi3.json" "$OUT/yuna.cdi3.json"

# 贴图：texture_00–02 缩到 2048×2048，texture_03（64×64）原样。
for index in 00 01 02; do
  src_png="$SRC_TEXTURES/texture_$index.png"
  [[ -f "$src_png" ]] || { echo "缺少贴图：$src_png" >&2; exit 1; }
  sips -z "$TEXTURE_SIZE" "$TEXTURE_SIZE" "$src_png" --out "$OUT/textures/texture_$index.png" >/dev/null
done
copy "$SRC_TEXTURES/texture_03.png" "$OUT/textures/texture_03.png"

# model3.json：改引用到 ASCII 名，其余字段原样保留。
python3 - "$SRC/漠.model3.json" "$OUT/yuna.model3.json" <<'PY'
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as handle:
    model = json.load(handle)

refs = model.setdefault("FileReferences", {})
refs["Moc"] = "yuna.moc3"
refs["Textures"] = [
    "textures/texture_00.png",
    "textures/texture_01.png",
    "textures/texture_02.png",
    "textures/texture_03.png",
]
refs["Physics"] = "yuna.physics3.json"
if "DisplayInfo" in refs:
    refs["DisplayInfo"] = "yuna.cdi3.json"

with open(dst, "w", encoding="utf-8") as handle:
    json.dump(model, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

echo "--- 输出内容 ---"
ls -la "$OUT" "$OUT/textures"

# 打印输出目录总大小（人类可读 + 字节）。
echo "--- 输出目录总大小 ---"
du -sh "$OUT"
echo "bytes: $(du -sk "$OUT" | awk '{print $1 * 1024}')"
