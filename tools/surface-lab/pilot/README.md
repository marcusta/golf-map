# Surface-model pilot

Can a per-pixel model trained on the hand-drawn courses draw a course it has never seen? Leave-one-course-out
(LOCO) over the sites `tools/surface-lab/prepare.py` built. Results: `data/experiments/surfaces/pilot/report.md`.

All commands from the repo root with the pipeline venv (`pipeline/.venv/Scripts/python.exe`, shortened to `py`).
Extra packages live in `tools/surface-lab/pilot/.deps` (appended to `sys.path` by `common.py`); model weights are
cached in `tools/surface-lab/pilot/.hf` (`HF_HOME`, set by `common.py`). To recreate `.deps`:

    py -m pip install --target tools/surface-lab/pilot/.deps --no-deps torchvision==0.29.1 timm==1.0.30 \
        segmentation-models-pytorch==0.5.0 "huggingface_hub<1.0" safetensors pyyaml tqdm lightgbm narwhals \
        scikit-learn joblib threadpoolctl cloudpickle hf-xet

(`--no-deps` so pip does not pull a second torch; huggingface_hub 1.x/2.x needs httpx2, hence `<1.0`.)

| step | command | what |
|---|---|---|
| 1 | `py tools/surface-lab/pilot/cache.py` | every ready site at 0.32 m into `data/experiments/surfaces/pilot/cache/<site>/` (crop = drawn bbox + 40 m inside the DEM); skips sites whose `ready.json` did not change |
| 2 | `py tools/surface-lab/pilot/baseline_lgbm.py --holdout all --inputs rgbnd` | LightGBM per-pixel baseline, LOCO, CPU only (`--inputs rgb\|rgbn\|rgbnd`) |
| 3 | `py tools/surface-lab/pilot/train.py --holdout Vreta --inputs rgbnd --bg --iters 4000 --tag <tag>` | UNet (ResNet-34 ImageNet) trained on the other cached sites, then predicts + scores the held-out one. `--bg` adds the "not course" class; `--seed`, `--encoder tu-convnext_tiny`, `--tile/--margin` (inference tiling); `--holdout Omberg:south` = dev split inside one site. rgbnd models are saved (fp16) as `runs/<tag>/<Site>.pt` |
| - | `bash tools/surface-lab/pilot/run_loco.sh [iters] [first-site]` | the report's grid: 5 held-out sites x rgbnd/rgb/rgbn (with `--bg`), a second seed of rgbnd and rgb, rgbnd without `--bg` on Vreta/Omberg. ~4.5 min per run |
| 4 | `py tools/surface-lab/pilot/render.py --tag loco-r34-rgbnd-bg --tif` | hole pictures + overviews into `pilot/images/`, `pilot/pred-<siteId>.tif` (band layout in the docstring) |
| 5 | `py tools/surface-lab/pilot/summarize.py --tags a,b,c --best a` | the markdown tables of the report |
| - | `py tools/surface-lab/pilot/predict.py --tag <tag> --tile 1024 --margin 192` | re-run a saved model with other tiling into `runs/<tag>-t1024/` |
| - | `py tools/surface-lab/pilot/rescore.py [--tags ...] [--site Omberg]` | score saved predictions again after a change to `metrics.py` |

Classes: the model predicts tee, green, fairway, semi_rough, rough, deep_rough, bunker, water, path, rock_slab
(+ background with `--bg`: undrawn and > 30 m from anything drawn, Omberg and Vreta only). `none`, `trees`
(Linkan's are lidar drafts) and `outside` are ignored. Metrics only where something trainable is drawn, Omberg's
Vättern (one 33 ha map lake) left out (`metrics.py` docstring). Runs land in
`data/experiments/surfaces/pilot/runs/<tag>/` (`<Site>.json` metrics + times, `<Site>-pred.npz` prediction on the
cache grid); logs in `data/experiments/surfaces/pilot/logs/`.

GPU: every CUDA step sits inside `gpu_lock("surface-pilot")` (`tools/surface-lab/gpulock.py`); peak ~1.8 GB
(ResNet-34, batch 8 x 384 px, bf16), ~2.6 GB with ConvNeXt-T. RAM: the cache is memory-mapped; a training run
holds ~2 GB.
