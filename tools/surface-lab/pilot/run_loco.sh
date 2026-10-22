#!/usr/bin/env bash
# The LOCO grid of report.md, sequential; each train.py takes the GPU lock itself.
#   bash tools/surface-lab/pilot/run_loco.sh [iters] [first-site]
# 1. every site held out in turn x three input sets, UNet ResNet-34 with the background class (seed 0)
# 2. a second seed of rgbnd and rgb (the noise floor of the ablation); rgbnd models are kept (fp16)
# 3. rgbnd without the background class on Vreta and Omberg
set -u
cd "$(dirname "$0")/../../.."
PY=pipeline/.venv/Scripts/python.exe
L=data/experiments/surfaces/pilot/logs
mkdir -p "$L"
IT=${1:-4000}
SITES="Vreta Omberg Landeryd Linkan Klinga"
if [ -n "${2:-}" ]; then SITES=$(echo "$SITES" | sed "s/.*\($2.*\)/\1/"); fi
run() {  # tag holdout inputs [extra args]
  local tag=$1 h=$2 inp=$3; shift 3
  $PY tools/surface-lab/pilot/train.py --holdout $h --inputs $inp --iters $IT --tag $tag "$@" \
    > $L/$tag-$h.log 2>&1 || echo "FAILED $tag $h"
  echo "done $tag $h $(date +%H:%M)"
}
for h in $SITES; do
  for inp in rgbnd rgb rgbn; do run loco-r34-$inp-bg $h $inp --bg; done
done
for h in Vreta Omberg Landeryd Linkan Klinga; do
  run loco-r34-rgbnd-bg-s1 $h rgbnd --bg --seed 1
  run loco-r34-rgb-bg-s1 $h rgb --bg --seed 1
done
for h in Vreta Omberg; do run loco-r34-rgbnd $h rgbnd; done
