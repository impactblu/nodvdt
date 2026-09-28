"""Keep a clone of the website repository and push collector results to it.

The token is handed to git through a credential helper that reads it from the
environment, so it is never written into .git/config or printed in logs.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

from .config import Settings

log = logging.getLogger("collector")

_CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'


class GitError(Exception):
    pass


def _git(settings: Settings, *args: str, cwd: Path | None = None) -> str:
    env = {**os.environ, "GITHUB_TOKEN": settings.github_token, "GIT_TERMINAL_PROMPT": "0",
           "GIT_AUTHOR_NAME": settings.git_author_name, "GIT_AUTHOR_EMAIL": settings.git_author_email,
           "GIT_COMMITTER_NAME": settings.git_author_name, "GIT_COMMITTER_EMAIL": settings.git_author_email}
    command = ["git", "-c", "credential.helper=", "-c", f"credential.helper={_CREDENTIAL_HELPER}", *args]
    result = subprocess.run(command, cwd=cwd or settings.repo_dir, env=env,
                            capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip().replace(settings.github_token or "\0", "***")
        raise GitError(f"git {args[0]} failed: {message}")
    return result.stdout


def remote_url(settings: Settings) -> str:
    # A full URL or local path is used as-is (handy for testing against a local copy).
    if "://" in settings.github_repo or settings.github_repo.startswith("/"):
        return settings.github_repo
    return f"https://github.com/{settings.github_repo}.git"


def prepare(settings: Settings) -> None:
    """Clone the repository if needed, then match the remote branch exactly."""
    repo = settings.repo_dir
    if not (repo / ".git").exists():
        repo.parent.mkdir(parents=True, exist_ok=True)
        if repo.exists() and any(repo.iterdir()):
            raise GitError(f"{repo} exists but is not a git clone. Empty it or choose another REPO_DIR.")
        log.info("Cloning %s", settings.github_repo)
        _git(settings, "clone", "--branch", settings.branch, remote_url(settings), str(repo), cwd=repo.parent)
    _git(settings, "remote", "set-url", "origin", remote_url(settings))
    _git(settings, "fetch", "origin", settings.branch)
    # The clone only ever holds the collector's own work, which is pushed at the
    # end of every run, so resetting to the remote never loses anything.
    _git(settings, "checkout", "-B", settings.branch, f"origin/{settings.branch}")
    _git(settings, "reset", "--hard", f"origin/{settings.branch}")


def code_version(settings: Settings) -> str | None:
    """Git tree id of the collector's own code in the clone (None before the first clone)."""
    if not (settings.repo_dir / ".git").exists():
        return None
    try:
        return _git(settings, "rev-parse", "HEAD:collector").strip()
    except GitError:
        return None


def has_changes(settings: Settings) -> bool:
    return bool(_git(settings, "status", "--porcelain", "--", "data", "datasheets").strip())


def commit_and_push(settings: Settings, message: str) -> bool:
    if not has_changes(settings):
        return False
    paths = [p for p in ("data", "datasheets") if (settings.repo_dir / p).exists()]
    _git(settings, "add", "--all", "--", *paths)
    _git(settings, "commit", "-m", message)
    if not settings.push:
        log.info("PUSH_CHANGES=false: committed locally, not pushed")
        return True
    try:
        _git(settings, "push", "origin", f"HEAD:{settings.branch}")
    except GitError:
        # Someone pushed in the meantime (e.g. an edit to suppliers.json). Replay on top and retry once.
        log.info("Push rejected; rebasing on the latest remote branch and retrying")
        _git(settings, "pull", "--rebase", "origin", settings.branch)
        _git(settings, "push", "origin", f"HEAD:{settings.branch}")
    return True
