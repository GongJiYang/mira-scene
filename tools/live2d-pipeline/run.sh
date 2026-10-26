#!/usr/bin/env bash
# One command for the whole pipeline: check config.json first (inputs, output dir, tool paths).
#
#   ./run.sh                 # steps 3..8 into output_dir
#   ./run.sh step3 step4     # only those steps
#   ./run.sh all --out /tmp/x --set step4_upscale.color_tolerance=30
#
# The interpreter must have psd-tools / opencv / pillow / numpy (see config.json -> env.python).
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CFG=${L2D_CONFIG:-"$HERE/config.json"}

PY=${L2D_PYTHON:-}
if [ -z "$PY" ]; then
  PY=$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["env"]["python"])' "$CFG")
fi
if [ ! -x "$PY" ]; then
  echo "python not executable: $PY (set L2D_PYTHON or env.python in $CFG)" >&2
  exit 1
fi

export PYTHONDONTWRITEBYTECODE=1
exec "$PY" -I "$HERE/pipeline.py" --config "$CFG" "$@"
