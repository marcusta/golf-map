"""Train a UNet on the cached sites minus one held-out course, then predict and score the held-out course.

    pipeline/.venv/Scripts/python.exe tools/surface-lab/pilot/train.py --holdout Vreta --inputs rgbnd [--iters 4000]
    ... --holdout Omberg:south     # dev check: train on Omberg's north half, score its south half

UNet (segmentation-models-pytorch) with an ImageNet ResNet-34 encoder, first conv widened for NIR/DEM channels.
Patches 384 px (123 m at 0.32 m) sampled 70 % class-balanced (a random class, a random site that has it, a random
pixel of it as the centre) and 30 % uniform over drawn pixels; flips/rot90; per-channel gain/bias jitter on the photo
bands (the flights differ in colour). CE with ignore 255. bf16 autocast, batch 8, AdamW + cosine.
Inference: 512 px tiles, 64 px margin dropped, flip TTA. Every CUDA step runs inside gpu_lock("surface-pilot").

--bg adds an 11th class "background" (not course, common.background_target); the main metrics then use the argmax
over the course classes only ("course mode", pred/conf) and res["auto"] the plain argmax (pred_auto/conf_auto).

Writes data/experiments/surfaces/pilot/runs/<tag>/<site>.json (metrics, times) and <site>-pred.npz
(pred = train index, conf = max softmax x 255, on the cache grid); rgbnd models (or --save-model) as <site>.pt (fp16).
"""
from __future__ import annotations

import argparse
import queue
import threading
import time

import numpy as np

from pathlib import Path

from common import (CACHE, DEM_SCALE, IGNORE, INPUT_SETS, OUT, RES, SITES, TRAIN_CLASSES, Site, cached_sites,
                    load_input, write_json)

NCLS = len(TRAIN_CLASSES)


def resolve(name: str) -> str:
    for k, v in SITES.items():
        if name in (k, v):
            return k
    raise SystemExit(f"unknown site {name}")


class Sampler:
    def __init__(self, sites: list[Site], input_set: str, patch: int, rows: dict, seed: int, bg: bool = False):
        self.sites = sites
        self.targets = [s.background_target() if bg else s.target for s in sites]
        ncls = NCLS + (1 if bg else 0)
        self.input_set = input_set
        self.patch = patch
        self.rows = rows  # site id -> (r0, r1) allowed rows (dev split)
        self.rng = np.random.default_rng(seed)
        self.cands = []  # per site: per class: (k, 2) coords
        self.uniform = []
        for s, t in zip(sites, self.targets):
            r0, r1 = rows.get(s.id, (0, s.shape[0]))
            per = []
            h = patch // 2
            for c in range(ncls):
                rr, cc = np.nonzero(t[r0 + h:r1 - h, h:s.shape[1] - h] == c)
                if rr.size > 200_000:
                    k = self.rng.choice(rr.size, 200_000, replace=False)
                    rr, cc = rr[k], cc[k]
                per.append(np.stack([rr + r0 + h, cc + h], 1) if rr.size >= 20 else None)
            self.cands.append(per)
            rr, cc = np.nonzero(t[r0 + h:r1 - h:4, h:s.shape[1] - h:4] < NCLS)  # drawn pixels
            self.uniform.append(np.stack([rr * 4 + r0 + h, cc * 4 + h], 1))
        self.classes = [c for c in range(ncls) if any(p[c] is not None for p in self.cands)]
        self.nphoto = len(INPUT_SETS[input_set]["photo"])

    def one(self):
        rng = self.rng
        if rng.random() < 0.7:
            c = self.classes[rng.integers(len(self.classes))]
            opts = [i for i, p in enumerate(self.cands) if p[c] is not None]
            si = opts[rng.integers(len(opts))]
            yx = self.cands[si][c][rng.integers(len(self.cands[si][c]))]
        else:
            si = rng.integers(len(self.sites))
            yx = self.uniform[si][rng.integers(len(self.uniform[si]))]
        s = self.sites[si]
        h = self.patch // 2
        y = int(yx[0] + rng.integers(-h // 2, h // 2 + 1))
        x = int(yx[1] + rng.integers(-h // 2, h // 2 + 1))
        r0, r1 = self.rows.get(s.id, (0, s.shape[0]))
        y = min(max(y, r0 + h), r1 - h)
        x = min(max(x, h), s.shape[1] - h)
        xin = load_input(s, self.input_set, y - h, y + h, x - h, x + h)
        tgt = np.array(self.targets[si][y - h:y + h, x - h:x + h])
        k = rng.integers(4)
        xin, tgt = np.rot90(xin, k, (1, 2)), np.rot90(tgt, k)
        if rng.random() < 0.5:
            xin, tgt = xin[:, :, ::-1], tgt[:, ::-1]
        xin = np.ascontiguousarray(xin)
        p = self.nphoto
        gain = rng.normal(1.0, 0.12, size=(p, 1, 1)).astype(np.float32)
        bias = rng.normal(0.0, 0.15, size=(p, 1, 1)).astype(np.float32)
        xin[:p] = xin[:p] * gain + bias
        return xin, np.ascontiguousarray(tgt)

    def batch(self, n):
        xs, ys = zip(*(self.one() for _ in range(n)))
        return np.stack(xs), np.stack(ys)


def prefetch(sampler: Sampler, bs: int, n: int):
    q: queue.Queue = queue.Queue(maxsize=6)

    def work():
        for _ in range(n):
            q.put(sampler.batch(bs))
        q.put(None)

    th = threading.Thread(target=work, daemon=True)
    th.start()
    while True:
        b = q.get()
        if b is None:
            return
        yield b


def build_model(in_ch: int, encoder: str, weights: str | None = "imagenet", ncls: int = NCLS):
    import segmentation_models_pytorch as smp
    return smp.Unet(encoder, encoder_weights=weights, in_channels=in_ch, classes=ncls)


def predict(model, site: Site, input_set: str, rows=None, tile=512, margin=64, tta=True):
    import torch
    H, W = site.shape
    r0, r1 = rows if rows else (0, H)
    pred = np.full((H, W), IGNORE, dtype=np.uint8)
    conf = np.zeros((H, W), dtype=np.uint8)
    pred_auto = np.full((H, W), IGNORE, dtype=np.uint8)
    conf_auto = np.zeros((H, W), dtype=np.uint8)
    step = tile - 2 * margin
    dev = "cuda"
    model.eval()
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
        for y in range(r0, r1, step):
            for x in range(0, W, step):
                ya, xa = max(y - margin, 0), max(x - margin, 0)
                yb, xb = min(y + step + margin, H), min(x + step + margin, W)
                xin = load_input(site, input_set, ya, yb, xa, xb)
                ph, pw = (-xin.shape[1]) % 32, (-xin.shape[2]) % 32
                xin = np.pad(xin, ((0, 0), (0, ph), (0, pw)), mode="reflect")
                t = torch.from_numpy(xin)[None].to(dev)
                logits = model(t).float()
                prob = logits.softmax(1)
                if tta:
                    prob = prob + model(t.flip(-1)).float().softmax(1).flip(-1)
                    prob = prob + model(t.flip(-2)).float().softmax(1).flip(-2)
                    prob = prob / 3
                prob = prob[0, :, :yb - ya, :xb - xa]
                cy0, cx0 = y - ya, x - xa
                cy1, cx1 = cy0 + min(step, r1 - y), cx0 + min(step, W - x)
                pc = prob[:, cy0:cy1, cx0:cx1]
                sl = (slice(y, y + (cy1 - cy0)), slice(x, x + (cx1 - cx0)))
                mx, am = pc.max(0)
                pred_auto[sl] = am.byte().cpu().numpy()
                conf_auto[sl] = (mx * 255).round().byte().cpu().numpy()
                if pc.shape[0] > NCLS:  # course mode: the course classes only, renormalised
                    pc = pc[:NCLS] / pc[:NCLS].sum(0, keepdim=True)
                    mx, am = pc.max(0)
                pred[sl] = am.byte().cpu().numpy()
                conf[sl] = (mx * 255).round().byte().cpu().numpy()
    return pred, conf, pred_auto, conf_auto


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--holdout", required=True,
                    help="site id or name; Name:south = dev split of one site; none = train on every cached site and "
                         "save the model + its card for golfpipe (--out)")
    ap.add_argument("--out", default=None, help="with --holdout none: where the model goes (.pt; card next to it)")
    ap.add_argument("--inputs", default="rgbnd", choices=list(INPUT_SETS))
    ap.add_argument("--iters", type=int, default=4000)
    ap.add_argument("--bs", type=int, default=8)
    ap.add_argument("--patch", type=int, default=384)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--encoder", default="resnet34")
    ap.add_argument("--tag", default=None)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--save-model", action="store_true")
    ap.add_argument("--bg", action="store_true", help="11th class: background (not course), see common.BG")
    ap.add_argument("--tile", type=int, default=512, help="inference tile (px)")
    ap.add_argument("--margin", type=int, default=64, help="inference tile margin dropped (px)")
    a = ap.parse_args()

    import torch
    from gpulock import gpu_lock
    from metrics import evaluate

    dev_split = ":" in a.holdout
    final = a.holdout == "none"
    hold = None if final else resolve(a.holdout.split(":")[0])
    tag = a.tag or f"unet-{a.encoder}-{a.inputs}"
    run_dir = OUT / "runs" / tag
    run_dir.mkdir(parents=True, exist_ok=True)
    name = "all" if final else SITES[hold] + ("-devsouth" if dev_split else "")

    test_site = None if final else Site(hold)
    if final:
        train_sites = [Site(s) for s in cached_sites()]
        rows = {}
        test_rows = None
    elif dev_split:
        H = test_site.shape[0]
        train_sites = [test_site]
        rows = {hold: (0, H // 2 - 64)}
        test_rows = (H // 2, H)
    else:
        train_sites = [Site(s) for s in cached_sites() if s != hold]
        rows = {}
        test_rows = None
    print(f"[{tag}] hold out {name}; train on {[s.name for s in train_sites]}", flush=True)
    t0 = time.time()
    sampler = Sampler(train_sites, a.inputs, a.patch, rows, a.seed, bg=a.bg)
    print(f"  sampler ready in {time.time() - t0:.0f} s; classes {[(TRAIN_CLASSES + ["background"])[c] for c in sampler.classes]}",
          flush=True)
    in_ch = len(INPUT_SETS[a.inputs]["photo"]) + len(INPUT_SETS[a.inputs]["dem"])
    torch.manual_seed(a.seed)
    model = build_model(in_ch, a.encoder, ncls=NCLS + (1 if a.bg else 0))

    with gpu_lock("surface-pilot"):
        free, total = torch.cuda.mem_get_info()
        print(f"  cuda free {free / 2**30:.1f} of {total / 2**30:.1f} GB", flush=True)
        model = model.cuda()
        opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
        warm = 200
        sched = torch.optim.lr_scheduler.LambdaLR(
            opt, lambda i: min(1.0, (i + 1) / warm) * 0.5 * (1 + np.cos(np.pi * min(i, a.iters) / a.iters)))
        lossf = torch.nn.CrossEntropyLoss(ignore_index=IGNORE)
        t1 = time.time()
        run_loss = None
        model.train()
        for it, (xb, yb) in enumerate(prefetch(sampler, a.bs, a.iters)):
            x = torch.from_numpy(xb).cuda(non_blocking=True)
            y = torch.from_numpy(yb).long().cuda(non_blocking=True)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                out = model(x)
            loss = lossf(out.float(), y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            run_loss = loss.item() if run_loss is None else 0.98 * run_loss + 0.02 * loss.item()
            if it % 250 == 0 or it == a.iters - 1:
                print(f"  it {it:5d} loss {run_loss:.3f} {time.time() - t1:.0f} s "
                      f"peak {torch.cuda.max_memory_allocated() / 2**30:.2f} GB", flush=True)
        train_s = time.time() - t1
        if final:
            out = Path(a.out) if a.out else run_dir / "all.pt"
            out.parent.mkdir(parents=True, exist_ok=True)
            torch.save({k: v.half() for k, v in model.state_dict().items()}, out)
            spec = INPUT_SETS[a.inputs]
            write_json(out.with_suffix(".json"), {
                "arch": "smp.Unet", "encoder": a.encoder, "inChannels": in_ch, "res": RES,
                "classes": TRAIN_CLASSES + (["background"] if a.bg else []),
                "photoBands": spec["photo"], "demBands": ["relief_2m", "relief_10m", "slope_deg"][:len(spec["dem"])],
                "demScale": DEM_SCALE[spec["dem"]].tolist(), "demClip": 6,
                "photoNorm": "per site: mean/std of each photo band over the site's photo (uint8 RGBI)",
                "trainSites": [s.name for s in train_sites], "iters": a.iters, "seed": a.seed, "trainSeconds": train_s,
                "built": time.strftime("%Y-%m-%dT%H:%M:%S")})
            print(f"  trained {train_s:.0f} s; model {out}", flush=True)
            return
        t2 = time.time()
        pred, conf, pred_auto, conf_auto = predict(model, test_site, a.inputs, rows=test_rows, tile=a.tile,
                                                   margin=a.margin)
        infer_s = time.time() - t2
        if a.save_model or a.inputs == "rgbnd":  # rgbnd models kept (fp16) for re-inference
            torch.save({k: v.half() for k, v in model.state_dict().items()}, run_dir / f"{name}.pt")
        model.cpu()
        del model, opt
    print(f"  trained {train_s:.0f} s, predicted {infer_s:.0f} s", flush=True)

    gt = np.array(test_site.target)
    inst = np.array(test_site.inst)
    if test_rows:
        gt[:test_rows[0]] = IGNORE
    res = evaluate(pred, gt, inst, test_site.features)
    if a.bg:  # fully automatic: background allowed to win on drawn pixels
        res["auto"] = evaluate(pred_auto, gt, inst, test_site.features, boundaries=False)
    px = int(test_site.shape[0] * test_site.shape[1] if not test_rows else (test_rows[1] - test_rows[0]) * test_site.shape[1])
    res.update({"holdout": hold, "name": name, "inputs": a.inputs, "encoder": a.encoder, "iters": a.iters,
                "bs": a.bs, "patch": a.patch, "trainSites": [s.name for s in train_sites], "train_s": train_s,
                "infer_s": infer_s, "inferMpx": px / 1e6, "devSplit": dev_split, "bg": a.bg, "tile": a.tile,
                "margin": a.margin})
    write_json(run_dir / f"{name}.json", res)
    extra = {"pred_auto": pred_auto, "conf_auto": conf_auto} if a.bg else {}
    np.savez_compressed(run_dir / f"{name}-pred.npz", pred=pred, conf=conf, **extra)
    iou = res["iou"]
    print("  IoU " + " ".join(f"{k}={v:.2f}" for k, v in iou.items() if v is not None), flush=True)
    print("  feat " + " ".join(f"{k}={v['recall50']:.2f}(n={v['n']})" for k, v in res["features"].items()
                               if v["recall50"] is not None), flush=True)
    if a.bg:
        print("  auto IoU " + " ".join(f"{k}={v:.2f}" for k, v in res["auto"]["iou"].items() if v is not None),
              flush=True)
    print("  F@1m " + " ".join(f"{k}={v['F@1.0m']:.2f}" for k, v in res["boundary"].items()), flush=True)


if __name__ == "__main__":
    main()
