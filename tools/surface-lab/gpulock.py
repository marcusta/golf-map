"""One GPU job at a time for the surface lab.

The SAM box bench and the surface-model pilot share one 16 GB card, and the open
Unity editors already hold most of it. Every CUDA job in tools/surface-lab takes
this lock first:

    from gpulock import gpu_lock
    with gpu_lock("sam-bench"):
        ...  # CUDA work

It blocks until the other job lets go (Windows drops the lock when the holder's
process dies, so a crash never leaves it stuck). The holder is written next to
the lock for whoever is waiting.
"""
from __future__ import annotations

import contextlib
import json
import msvcrt
import os
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LOCK = REPO / "data" / "experiments" / "gpu.lock"
OWNER = LOCK.with_suffix(".owner.json")


def free_vram_mb() -> int | None:
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        free, _ = torch.cuda.mem_get_info()
        return int(free / 2**20)
    except Exception:
        return None


@contextlib.contextmanager
def gpu_lock(owner: str, poll_s: float = 5.0):
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    f = open(LOCK, "a+")
    last_note = 0.0
    while True:
        try:
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            break
        except OSError:
            if time.time() - last_note > 60:
                try:
                    holder = json.loads(OWNER.read_text())
                except Exception:
                    holder = {}
                print(f"[gpulock] {owner} waits for the GPU (held by {holder.get('owner', '?')} since {holder.get('since', '?')})", flush=True)
                last_note = time.time()
            time.sleep(poll_s)
    OWNER.write_text(json.dumps({"owner": owner, "pid": os.getpid(), "since": time.strftime("%H:%M:%S")}))
    try:
        yield
    finally:
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        f.close()
