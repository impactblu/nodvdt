"""Command line entry point.

    python -m collector run            check sources every CHECK_INTERVAL_HOURS, push results
    python -m collector run --once     one pass, then exit
    python -m collector run --once --no-git --root PATH
                                       one pass against a local working copy (for testing)
    python -m collector validate [--root PATH]
                                       check data/ for consistency (used by GitHub Actions)
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path

from . import collect, config, gitsync, validate
from .store import Catalog

log = logging.getLogger("collector")


def one_pass(settings: config.Settings, use_git: bool, root: Path) -> None:
    if use_git:
        gitsync.prepare(settings)
    catalog = Catalog.load(root)
    if not catalog.suppliers:
        raise SystemExit(f"No data/suppliers.json under {root}. Is REPO_DIR the website repository?")
    summary = collect.run(catalog, settings)
    catalog.save()

    issues = validate.problems(root, check_hashes=False)
    if issues:
        # Never push data that would fail the website build.
        raise RuntimeError("Collected data failed validation:\n  " + "\n  ".join(issues))

    log.info(summary.commit_message())
    for error in summary.errors:
        log.warning("Source problem: %s", error)
    if use_git and gitsync.commit_and_push(settings, summary.commit_message()):
        log.info("Pushed to %s (%s)", settings.github_repo, settings.branch)


def check_writable(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    probe = path / ".write-test"
    try:
        probe.write_text("ok")
        probe.unlink()
    except OSError as exc:
        raise SystemExit(
            f"Cannot write to {path} ({exc}).\n"
            f"The container runs as user {os.getuid()}:{os.getgid()}. In UGOS File Manager, give that "
            "user read/write permission on the pcs-atlas/repo folder, or change `user:` in compose.yaml."
        )


def cmd_run(args) -> None:
    settings = config.load()
    use_git = not args.no_git
    root = Path(args.root) if args.root else settings.repo_dir
    if use_git:
        if not settings.github_token:
            raise SystemExit("GITHUB_TOKEN is not set. Add it to the .env file next to compose.yaml.")
        check_writable(settings.repo_dir.parent)
        if not os.getenv("GIT_AUTHOR_EMAIL"):
            log.warning("GIT_AUTHOR_EMAIL is not set. Vercel may refuse to deploy the collector's commits; "
                        "use the email linked to your GitHub/Vercel account.")

    while True:
        started = time.monotonic()
        try:
            one_pass(settings, use_git, root)
        except (gitsync.GitError, RuntimeError) as exc:
            log.error("%s", exc)
            if args.once:
                raise SystemExit(1)
        if args.once:
            return
        sleep_for = settings.check_interval_hours * 3600 - (time.monotonic() - started)
        log.info("Next check in %.1f hours", max(sleep_for, 0) / 3600)
        time.sleep(max(sleep_for, 60))


def cmd_validate(args) -> None:
    root = Path(args.root)
    issues = validate.problems(root)
    if issues:
        print("Data problems found:")
        for issue in issues:
            print("  -", issue)
        raise SystemExit(1)
    print("Data OK")


def main(argv=None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(prog="collector")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="check supplier sources and publish changes")
    run.add_argument("--once", action="store_true", help="run one pass and exit")
    run.add_argument("--no-git", action="store_true", help="work on a local copy; do not clone or push")
    run.add_argument("--root", help="repository root to use with --no-git")
    run.set_defaults(func=cmd_run)

    check = sub.add_parser("validate", help="check the data folder for consistency")
    check.add_argument("--root", default=".", help="repository root (default: current folder)")
    check.set_defaults(func=cmd_validate)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
