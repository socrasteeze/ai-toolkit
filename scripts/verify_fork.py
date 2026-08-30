"""Post-merge tripwire for the fork's surface against upstream (fork-only tool).

FORK_NOTES.md's sync procedure ends with a list of things to re-check "by grep, not
by assumption" after every `git merge upstream/main`. Every sync log entry repeats
them by hand. This runs them.

    python scripts/verify_fork.py              # all checks
    python scripts/verify_fork.py --list       # what it would check
    python scripts/verify_fork.py --skip-git   # file checks only (no git calls)

Exit code 0 when every check passes, 1 otherwise. Checks:

1. insertions  - each documented fork insertion into an upstream file is still there
2. touchpoints - `git diff upstream/main --name-status | grep -v '^A'` still equals
                 EXPECTED_TOUCHPOINTS, and reports the drift by name if not.
                 Skipped (not failed) while the fork is behind upstream, because the
                 count is meaningless mid-sync — see CLAUDE.md's warning
3. next-params - every App Router `params` prop is the Next 15 `Promise<...>` shape;
                 upstream keeps shipping the stale Next 14 sync type
4. fork-docs   - no `forkDocs.tsx` key also exists in upstream's `docs.tsx` (a
                 shadowed key silently stops rendering, and once rendered WRONG)
5. presets     - BUILTIN_PRESET_NAMES lists exactly the files in presets/

Update EXPECTED_TOUCHPOINTS and INSERTIONS in the same commit as any change to the
merge surface, exactly as FORK_NOTES.md's table requires.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Keep in step with FORK_NOTES.md's "Upstream files modified" table.
EXPECTED_TOUCHPOINTS = 57

# (file, needle, what it is). Substring match, not regex — these are anchors that
# survive reformatting, not exact lines.
INSERTIONS = [
    ("ui/src/app/jobs/new/page.tsx", "PresetManager", "Presets dialog mount"),
    ("ui/src/app/jobs/new/page.tsx", "HelpModeButton", "Help mode button mount"),
    ("ui/src/app/jobs/new/page.tsx", "useMachines", "peer-aware GPU picker hook"),
    ("ui/src/app/jobs/new/SimpleJob.tsx", "StepSuggestion", "step advisor mount"),
    ("ui/src/app/jobs/new/SimpleJob.tsx", "OptimizerHint", "optimizer hint mount"),
    ("ui/src/app/jobs/new/SimpleJob.tsx", "DatasetFolderPickerModal", "folder picker mount"),
    ("ui/src/app/jobs/new/SimpleJob.tsx", "useHelpMode", "help mode hook"),
    ("ui/src/app/datasets/[datasetName]/page.tsx", "DatasetTools", "Dataset Tools mount"),
    ("ui/src/app/settings/page.tsx", "PeerSettings", "peer settings mount"),
    ("ui/src/docs.tsx", "forkDocs", "fork doc registry fallthrough"),
    ("ui/src/components/JobOverview.tsx", "parseLocalGpuIndices", "remote-safe GPU parse"),
    ("ui/src/components/CaptionMonitor.tsx", "parseLocalGpuIndices", "remote-safe GPU parse"),
    ("ui/src/components/JobsTable.tsx", "splitPeerGpu", "remote job grouping"),
    ("ui/cron/actions/startJob.ts", "startRemoteJob", "remote handoff branch"),
    ("ui/cron/actions/startJob.ts", "markJobError", "crash-safe job launch"),
    ("ui/cron/worker.ts", "unhandledRejection", "worker crash safety net"),
    ("ui/cron/worker.ts", "queuePollMs", "queue scan interval"),
    ("ui/src/server/apiCache.ts", "pending", "in-flight sharing + pending deadline"),
    ("ui/src/app/api/gpu/route.ts", "NVIDIA_SMI_TIMEOUT_MS", "bounded nvidia-smi"),
    ("ui/src/server/monitor.ts", "NVIDIA_SMI_TIMEOUT_MS", "bounded nvidia-smi"),
    ("ui/src/app/api/datasets/create/route.tsx", "resolveDatasetPath", "traversal guard"),
    ("ui/src/app/api/datasets/delete/route.tsx", "resolveDatasetPath", "traversal guard"),
    ("ui/src/app/api/datasets/upload/route.ts", "sanitizeDatasetName", "traversal guard"),
    ("ui/src/app/api/zip/route.ts", "sanitizeDatasetName", "traversal guard"),
    ("ui/package.json", "tests/register.mjs", "fork test script"),
    ("toolkit/config_modules.py", "loss_sync_every", "fork speed key"),
    ("toolkit/config_modules.py", "ui_db_poll_seconds", "fork speed key"),
    ("toolkit/config_modules.py", "normalize_included_subfolders", "dataset scope"),
    ("toolkit/config_modules.py", "_is_automagic", "Automagic accumulation guard"),
    ("toolkit/data_loader.py", "list_dataset_media_files", "dataset scope walk"),
    ("extensions_built_in/sd_trainer/SDTrainer.py", "neutralize_nonfinite_loss", "gated NaN handling"),
    ("extensions_built_in/sd_trainer/SDTrainer.py", "DeferredLossTracker", "deferred loss sync"),
    ("extensions_built_in/sd_trainer/DiffusionTrainer.py", "_fork_last_db_poll", "UI db poll throttle"),
    ("build_and_push_docker", "socrasteeze/aitoolkit", "fork docker target"),
]

# Files whose absence of a needle is the failure (a deletion the fork made).
# Checked against the file with comments stripped: the fork documents these removals
# in a comment right where the code used to be, and that must not read as a relapse.
ABSENCES = [
    ("ui/src/components/Modal.tsx", "backdrop-blur", "full-viewport backdrop blur (perf)"),
]

_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"^\s*(//|#).*$", re.MULTILINE)


def strip_comments(text):
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", text))


class Result:
    def __init__(self):
        self.failures = []
        self.skipped = []

    def fail(self, check, message):
        self.failures.append(f"{check}: {message}")

    def skip(self, check, message):
        self.skipped.append(f"{check}: {message}")


def read(rel):
    path = REPO_ROOT / rel
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def check_insertions(result):
    for rel, needle, what in INSERTIONS:
        text = read(rel)
        if text is None:
            result.fail("insertions", f"{rel} is missing entirely ({what})")
        elif needle not in text:
            result.fail("insertions", f"{rel} lost its {what} (no {needle!r})")
    for rel, needle, what in ABSENCES:
        text = read(rel)
        if text is None:
            result.fail("insertions", f"{rel} is missing entirely")
        elif needle in strip_comments(text):
            result.fail("insertions", f"{rel} reintroduced {needle!r} in code — {what} was removed on purpose")


def git(*args):
    return subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )


def check_touchpoints(result):
    if git("rev-parse", "--verify", "-q", "upstream/main").returncode != 0:
        result.skip("touchpoints", "no upstream/main ref (add the remote and fetch)")
        return
    behind = git("rev-list", "--count", "HEAD..upstream/main").stdout.strip()
    if behind and behind != "0":
        # CLAUDE.md: the count is wrong while behind — every file upstream changed and
        # the fork never touched is reported as a fork modification too.
        result.skip("touchpoints", f"{behind} commits behind upstream/main; count is meaningless mid-sync")
        return
    proc = git("diff", "upstream/main", "--name-status")
    modified = [
        line.split("\t", 1)[1]
        for line in proc.stdout.splitlines()
        if line and not line.startswith("A")
    ]
    if len(modified) != EXPECTED_TOUCHPOINTS:
        result.fail(
            "touchpoints",
            f"{len(modified)} modified upstream files, expected {EXPECTED_TOUCHPOINTS}. "
            f"Update FORK_NOTES.md's table and EXPECTED_TOUCHPOINTS together.\n    "
            + "\n    ".join(sorted(modified)),
        )


def check_next_params(result):
    app = REPO_ROOT / "ui" / "src" / "app"
    if not app.is_dir():
        result.skip("next-params", "ui/src/app not found")
        return
    # `{ params }: { params: { x: string } }` — the Next 14 shape upstream keeps shipping
    stale = re.compile(r"params:\s*\{\s*[A-Za-z_$][\w$]*\s*:")
    for path in sorted(app.rglob("*.ts*")):
        text = path.read_text(encoding="utf-8", errors="replace")
        if "params" not in text:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if stale.search(line) and "Promise<" not in line:
                rel = path.relative_to(REPO_ROOT).as_posix()
                result.fail("next-params", f"{rel}:{i} uses the Next 14 sync params type")


def doc_keys(rel):
    text = read(rel)
    if text is None:
        return None
    return set(re.findall(r"^\s{2}'([a-z0-9_.]+)':", text, re.MULTILINE))


def check_fork_docs(result):
    fork = doc_keys("ui/src/forkDocs.tsx")
    upstream = doc_keys("ui/src/docs.tsx")
    if fork is None or upstream is None:
        result.skip("fork-docs", "docs.tsx or forkDocs.tsx not found")
        return
    overlap = sorted(fork & upstream)
    if overlap:
        result.fail(
            "fork-docs",
            "these keys exist in BOTH registries, so the fork's copy is dead (and may be "
            "wrong — it bit on 2026-08-11). Delete the fork side and move the matching "
            "docKey in SimpleJob.tsx from h('…') to a bare literal:\n    " + "\n    ".join(overlap),
        )


def check_builtin_presets(result):
    text = read("ui/src/server/builtinPresets.ts")
    presets_dir = REPO_ROOT / "presets"
    if text is None or not presets_dir.is_dir():
        result.skip("presets", "builtinPresets.ts or presets/ not found")
        return
    listed = set(re.findall(r"^\s*'([^']+)',", text, re.MULTILINE))
    shipped = {
        p.stem for p in presets_dir.iterdir()
        if p.suffix.lower() in {".json", ".jsonc", ".yaml", ".yml"}
    }
    missing = sorted(shipped - listed)
    extra = sorted(listed - shipped)
    if missing:
        result.fail("presets", f"shipped but not in BUILTIN_PRESET_NAMES: {', '.join(missing)}")
    if extra:
        result.fail("presets", f"in BUILTIN_PRESET_NAMES but not shipped: {', '.join(extra)}")


CHECKS = [
    ("insertions", check_insertions, False),
    ("touchpoints", check_touchpoints, True),
    ("next-params", check_next_params, False),
    ("fork-docs", check_fork_docs, False),
    ("presets", check_builtin_presets, False),
]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--skip-git", action="store_true", help="skip checks that shell out to git")
    ap.add_argument("--list", action="store_true", help="list the checks and exit")
    args = ap.parse_args()

    if args.list:
        for name, _fn, needs_git in CHECKS:
            print(f"  {name}{' (git)' if needs_git else ''}")
        print(f"\n  {len(INSERTIONS)} insertion anchors, {len(ABSENCES)} required absences")
        return 0

    result = Result()
    for name, fn, needs_git in CHECKS:
        if needs_git and args.skip_git:
            result.skip(name, "--skip-git")
            continue
        before = len(result.failures)
        fn(result)
        if len(result.failures) == before and not any(s.startswith(f"{name}:") for s in result.skipped):
            print(f"  OK    {name}")
    for line in result.skipped:
        print(f"  SKIP  {line}")
    for line in result.failures:
        print(f"  FAIL  {line}")

    if result.failures:
        print(f"\nfork verification FAILED: {len(result.failures)} problem(s). "
              f"See FORK_NOTES.md's merge-surface table.")
        return 1
    print("\nfork verification OK"
          + (f" ({len(result.skipped)} skipped)" if result.skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
