import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from collector import config, gitsync


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
                        "GIT_COMMITTER_EMAIL": "t@t", "HOME": str(cwd), "PATH": "/usr/bin:/bin"})


class GitSyncTests(unittest.TestCase):
    def test_clone_commit_push_and_recover_from_concurrent_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            remote = tmp / "remote.git"
            git(tmp, "init", "--bare", "-b", "main", str(remote))
            seed = tmp / "seed"
            git(tmp, "clone", str(remote), str(seed))
            (seed / "data").mkdir()
            (seed / "data" / "status.json").write_text("{}")
            (seed / "README.md").write_text("hi")
            git(seed, "add", ".")
            git(seed, "commit", "-m", "init")
            git(seed, "push", "origin", "HEAD:main")

            settings = config.Settings(repo_dir=tmp / "work" / "repo", github_repo="x/y", github_token="secret",
                                       branch="main", push=True, check_interval_hours=24,
                                       request_delay_seconds=1, max_file_mb=5, user_agent="t",
                                       git_author_name="Collector", git_author_email="c@example.com")
            with mock.patch.object(gitsync, "remote_url", return_value=str(remote)):
                gitsync.prepare(settings)
                self.assertFalse(gitsync.has_changes(settings))

                # Someone edits the repo on GitHub while the collector is working.
                (seed / "README.md").write_text("edited")
                git(seed, "commit", "-am", "edit")
                git(seed, "push", "origin", "HEAD:main")

                (settings.repo_dir / "data" / "status.json").write_text('{"ok": true}')
                self.assertTrue(gitsync.commit_and_push(settings, "Collector: test"))

            log = subprocess.run(["git", "--git-dir", str(remote), "log", "--format=%an|%s", "main"],
                                 capture_output=True, text=True).stdout.splitlines()
            self.assertEqual(log[0], "Collector|Collector: test")
            self.assertEqual(log[1], "t|edit")
            config_text = (settings.repo_dir / ".git" / "config").read_text()
            self.assertNotIn("secret", config_text)


if __name__ == "__main__":
    unittest.main()
