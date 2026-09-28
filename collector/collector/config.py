"""Settings, read from environment variables (see collector/.env.example)."""

import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str) -> str:
    """Environment variable, treating an empty value (NAME=) as unset."""
    return os.getenv(name) or default


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    # Where the website repository is checked out inside the container.
    repo_dir: Path
    # "owner/name" of the GitHub repository, e.g. "impactblu/nodvdt".
    github_repo: str
    # Fine-grained token with Contents: read and write on that repository only.
    github_token: str
    branch: str
    push: bool
    check_interval_hours: float
    request_delay_seconds: float
    max_file_mb: int
    user_agent: str
    git_author_name: str
    git_author_email: str

    @property
    def max_file_bytes(self) -> int:
        return self.max_file_mb * 1024 * 1024


def load() -> Settings:
    return Settings(
        repo_dir=Path(_env("REPO_DIR", "/work/repo")),
        github_repo=_env("GITHUB_REPO", "impactblu/nodvdt"),
        github_token=_env("GITHUB_TOKEN", ""),
        branch=_env("GIT_BRANCH", "main"),
        push=_bool("PUSH_CHANGES", True),
        check_interval_hours=max(1.0, float(_env("CHECK_INTERVAL_HOURS", "24"))),
        request_delay_seconds=max(1.0, float(_env("REQUEST_DELAY_SECONDS", "2"))),
        max_file_mb=int(_env("MAX_FILE_MB", "40")),
        user_agent=os.getenv(
            "USER_AGENT", "PCSAtlasCollector/2.0 (+https://nodvdt.com/#/about)"
        ),
        git_author_name=_env("GIT_AUTHOR_NAME", "PCS Atlas collector"),
        git_author_email=_env("GIT_AUTHOR_EMAIL", "collector@nodvdt.com"),
    )
