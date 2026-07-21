#!/usr/bin/env python3
"""Speed-benchmark harness for ai-toolkit training configs (fork-only tool).

Runs a training config for a fixed number of steps with sampling disabled and
mid-run saves pushed out of range, measures true end-to-end steps/s from the
trainer's own performance-log markers (so it includes dataloading, logging, and
every other per-step overhead — not just the inner train_loop), polls nvidia-smi
for peak VRAM, and appends a markdown row to docs/speed_benchmarks.md.

Protocol (FORK_NOTES.md "Speed optimization"): 200 steps, discard the first 20
as warmup, report mean steps/s over the remainder. Change ONE config variable
per run and label it.

Usage (from the repo root, inside the training venv):
    python scripts/bench_speed.py --config config/examples/train_lora_anima_2b.yaml \
        --label baseline-stock
    python scripts/bench_speed.py --config config/examples/train_lora_anima_2b_5090_fast.yaml \
        --label fast-profile

Notes:
- The config's dataset folder_path must point at the real benchmark dataset.
  Use the SAME dataset, resolution list, and seed for every run in a series.
- First run of a series warms the latent/text-embed caches; re-run it and keep
  the second number (or pre-warm with --steps 25 once).
- CLI runs skip the UI sqlite polling entirely, so ui_db_poll_seconds shows no
  effect here — benchmark that one from a UI-launched job (watch the UI's own
  it/s readout), or compare total wall-clock of two UI runs.
"""

import argparse
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKER_RE = re.compile(r"^Timer '")
TRAIN_LOOP_RE = re.compile(r"-\s+([0-9.]+)s avg\s+-\s+train_loop")


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    if path.endswith(".json"):
        return json.loads(text)
    import yaml  # part of the training venv requirements
    return yaml.safe_load(text)


def apply_overrides(cfg, args):
    proc = cfg["config"]["process"][0]
    cfg["config"]["name"] = f"bench_{args.label}"
    proc["training_folder"] = args.output_dir
    proc["performance_log_every"] = args.marker_every
    train = proc.setdefault("train", {})
    train["steps"] = args.steps
    train["disable_sampling"] = True
    # push saves out of range; the final save at run end is unavoidable but
    # falls outside the measured marker window
    proc.setdefault("save", {})["save_every"] = args.steps + 1
    # a UI preset carries these; they don't exist in a CLI run
    proc.pop("sqlite_db_path", None)
    return cfg


class VramPoller(threading.Thread):
    def __init__(self, interval=2.0):
        super().__init__(daemon=True)
        self.interval = interval
        self.peak_mib = None
        self._stop = threading.Event()

    def run(self):
        while not self._stop.is_set():
            try:
                out = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=memory.used",
                     "--format=csv,noheader,nounits"],
                    text=True, stderr=subprocess.DEVNULL)
                used = max(int(x) for x in out.split())
                if self.peak_mib is None or used > self.peak_mib:
                    self.peak_mib = used
            except Exception:
                pass  # no nvidia-smi (or transient failure): report peak as n/a
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


def gpu_name():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            text=True, stderr=subprocess.DEVNULL)
        return out.strip().splitlines()[0]
    except Exception:
        return "unknown GPU"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", required=True, help="training config (yaml/json)")
    ap.add_argument("--label", required=True,
                    help="short run label for the results table (what changed)")
    ap.add_argument("--steps", type=int, default=200)
    ap.add_argument("--warmup", type=int, default=20,
                    help="steps discarded before measurement starts")
    ap.add_argument("--marker-every", type=int, default=10,
                    help="performance_log_every interval used as step markers")
    ap.add_argument("--output-dir", default=os.path.join(REPO_ROOT, "output", "_bench"))
    ap.add_argument("--results", default=os.path.join(REPO_ROOT, "docs", "speed_benchmarks.md"))
    ap.add_argument("--keep-output", action="store_true",
                    help="keep the bench job's output folder (deleted by default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="write the effective bench config and exit")
    args = ap.parse_args()

    if args.warmup % args.marker_every:
        ap.error("--warmup must be a multiple of --marker-every")
    if args.steps <= args.warmup + args.marker_every:
        ap.error("--steps must exceed --warmup by at least one marker interval")

    cfg = apply_overrides(load_config(args.config), args)
    tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", prefix="bench_", delete=False, encoding="utf-8")
    json.dump(cfg, tmp, indent=2)
    tmp.close()
    print(f"[bench] effective config: {tmp.name}")
    if args.dry_run:
        return 0

    poller = VramPoller()
    poller.start()
    marker_times = []          # wall-clock arrival time of each Timer block
    train_loop_avgs = []
    t0 = time.time()
    # -u: unbuffered child stdout so markers arrive when printed
    child = subprocess.Popen(
        [sys.executable, "-u", os.path.join(REPO_ROOT, "run.py"), tmp.name],
        cwd=REPO_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace")
    try:
        for line in child.stdout:
            sys.stdout.write(line)
            if MARKER_RE.match(line):
                marker_times.append(time.time())
            m = TRAIN_LOOP_RE.search(line)
            if m:
                train_loop_avgs.append(float(m.group(1)))
        rc = child.wait()
    except KeyboardInterrupt:
        child.terminate()
        raise
    finally:
        poller.stop()
        wall = time.time() - t0

    if rc != 0:
        print(f"[bench] run.py exited with code {rc}; no result recorded")
        return rc

    # marker k arrives just after step k*marker_every completes (first marker =
    # step 0). Measure from the first marker at/after --warmup to the last.
    first_idx = args.warmup // args.marker_every
    if len(marker_times) <= first_idx + 1:
        print(f"[bench] only {len(marker_times)} markers seen — is "
              f"performance_log_every reaching the trainer? No result recorded.")
        return 1
    measured_steps = (len(marker_times) - 1 - first_idx) * args.marker_every
    measured_secs = marker_times[-1] - marker_times[first_idx]
    steps_per_sec = measured_steps / measured_secs
    # inner-loop metric over the same window (one avg printed per marker)
    inner = train_loop_avgs[first_idx + 1:] or [float("nan")]
    inner_avg = sum(inner) / len(inner)

    row = "| {date} | {label} | {cfg} | {sps:.3f} | {spstep:.3f} | {inner:.3f} | {vram} | {wall:.0f}s | {gpu} |".format(
        date=_dt.date.today().isoformat(),
        label=args.label,
        cfg=os.path.relpath(args.config, REPO_ROOT).replace("\\", "/"),
        sps=steps_per_sec,
        spstep=1.0 / steps_per_sec,
        inner=inner_avg,
        vram=f"{poller.peak_mib} MiB" if poller.peak_mib is not None else "n/a",
        wall=wall,
        gpu=gpu_name(),
    )
    header = ("| date | label | config | steps/s | s/step | train_loop s | peak VRAM | wall | GPU |\n"
              "|---|---|---|---|---|---|---|---|---|\n")
    os.makedirs(os.path.dirname(args.results), exist_ok=True)
    new_file = not os.path.exists(args.results)
    with open(args.results, "a", encoding="utf-8") as f:
        if new_file:
            f.write("# Speed benchmarks\n\nAppended by `scripts/bench_speed.py`. "
                    "Protocol: FORK_NOTES.md \"Speed optimization\".\n\n" + header)
        f.write(row + "\n")
    print("\n[bench] " + row)
    print(f"[bench] appended to {args.results}")

    bench_job_dir = os.path.join(args.output_dir, cfg["config"]["name"])
    if not args.keep_output and os.path.isdir(bench_job_dir):
        shutil.rmtree(bench_job_dir, ignore_errors=True)
        print(f"[bench] removed {bench_job_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
