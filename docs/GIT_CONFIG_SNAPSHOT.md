# Git configuration snapshot

A snapshot of how this repository is configured on the primary development
machine, captured 2026-08-29 for external review.

**No credentials are present in this document.** Authentication to GitHub is by
SSH key, so the remote URL carries no token, and no `credential.helper`,
`http.extraheader`, or `Authorization` value is set in any scope. This was
verified with a scan across the local, global, and system config scopes before
this file was written.

This is a point-in-time snapshot, not a live file. Git does not read it — the
real configuration lives in `.git/config`, which is deliberately untracked
because it is machine-specific. Expect this snapshot to drift; regenerate it
rather than trusting it as current.

---

## 1. Repository-local config (`.git/config`)

The authoritative per-repo settings. `[remote "origin"]` and the `[branch …]`
tracking entries are the meaningful part; the `vscode-merge-base` keys are
written by the VS Code Git integration and carry no behavioral weight.

```ini
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
[remote "origin"]
	url = git@github.com:Jayrod-21/K-Learning-App.git
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "rebuild"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/rebuild
[branch "deploy/reading-plus-swipe"]
	vscode-merge-base = origin/rebuild
[branch "feat/f209-preseed-tool"]
	vscode-merge-base = origin/feat/f209-instant-definitions
[branch "fix/kiwi-lemmatize-schema"]
	vscode-merge-base = origin/rebuild
[branch "deploy/f209-plus-kiwi"]
	vscode-merge-base = origin/rebuild
[branch "feat/f209-weekly-preseed"]
	vscode-merge-base = origin/rebuild
[branch "chore/backlog-f219"]
	remote = origin
	merge = refs/heads/chore/backlog-f219
	vscode-merge-base = origin/rebuild
[branch "feat/illustrations-listen-card"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/feat/illustrations-listen-card
[branch "feat/storybook-reader"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/feat/storybook-reader
[branch "feat/generation-timeout"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/feat/generation-timeout
[branch "feat/diagnostic-per-category"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/feat/diagnostic-per-category
[branch "feat/diagnostic-polish"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/feat/diagnostic-polish
[branch "chore/backlog-ideas"]
	remote = origin
	vscode-merge-base = origin/rebuild
	merge = refs/heads/chore/backlog-ideas
[branch "chore/phase2-admin-role"]
	remote = origin
	merge = refs/heads/chore/phase2-admin-role
[branch "feat/phase2-spend-ceiling"]
	vscode-merge-base = origin/chore/phase2-admin-role
	remote = origin
	merge = refs/heads/feat/phase2-spend-ceiling
[branch "feat/phase2-invite-codes"]
	remote = origin
	merge = refs/heads/feat/phase2-invite-codes
	vscode-merge-base = origin/rebuild
[branch "feat/phase2-scoping-fixes"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/phase2-scoping-fixes
[branch "test/phase2-mfa-hardening"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/test/phase2-mfa-hardening
[branch "test/phase2-two-user-harness"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/test/phase2-two-user-harness
[branch "feat/phase2-async-upload"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/phase2-async-upload
[branch "feat/f220-generated-item-bank"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/f220-generated-item-bank
[branch "feat/f220-reading-generator"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/f220-reading-generator
[branch "feat/f220-listening-generator"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/f220-listening-generator
[branch "fix/canonical-grammar-loader-paths"]
	remote = origin
	merge = refs/heads/fix/canonical-grammar-loader-paths
	vscode-merge-base = origin/rebuild
[branch "feat/f220-paired-stimulus"]
	remote = origin
	merge = refs/heads/feat/f220-paired-stimulus
[branch "feat/f220-single-item-types"]
	remote = origin
	merge = refs/heads/feat/f220-single-item-types
[branch "feat/f220-generated-mock-surface"]
	remote = origin
	merge = refs/heads/feat/f220-generated-mock-surface
	vscode-merge-base = origin/feat/f220-single-item-types
[branch "feat/f220-writing-items"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/f220-writing-items
[branch "feat/story-public-library"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/feat/story-public-library
[branch "docs/backlog-f230-f239"]
	vscode-merge-base = origin/rebuild
	remote = origin
	merge = refs/heads/docs/backlog-f230-f239
[branch "docs/git-config-snapshot"]
	vscode-merge-base = origin/rebuild
```

### Notes

- **Remote** — `git@github.com:Jayrod-21/K-Learning-App.git`, SSH. There is no
  HTTPS remote and no embedded credential.
- **Default branch** — `rebuild`, not `main`. Every feature branch is cut from
  `rebuild` and every pull request targets it.
- **Branch entries** — roughly thirty, one per feature branch worked to date.
  Many refer to branches already merged and deleted on the remote; the local
  entries are simply stale bookkeeping and are harmless.

---

## 2. Global config that applies to this repo (`~/.gitconfig`)

Machine-wide settings, inherited by this repository:

```ini
[user]
	name = Jared Williams
	email = jaredmwilliams.me@gmail.com
[core]
	hooksPath = /home/jared-williams/.config/git/hooks
```

The `core.hooksPath` override is the significant line: it redirects hook lookup
away from `.git/hooks` to a shared machine-wide directory, so **this repository
runs no hooks of its own** — `.git/hooks` contains only Git's stock `.sample`
files. The hooks that actually run are the shared ones in section 3.

---

## 3. Active hooks

Because of `core.hooksPath`, the only hook that runs on commit in this repo is a
machine-wide secret scan:

```bash
#!/usr/bin/env bash
# Global pre-commit secret scan — blocks any commit whose staged changes
# contain a secret. Applies to every git repo on this machine via
#   git config --global core.hooksPath ~/.config/git/hooks
#
# Bypass intentionally (e.g. a confirmed false positive):
#   git commit --no-verify

if command -v gitleaks >/dev/null 2>&1; then
  GL=gitleaks
elif [ -x "$HOME/.local/bin/gitleaks" ]; then
  GL="$HOME/.local/bin/gitleaks"
else
  # gitleaks not installed on this machine — don't block commits
  exit 0
fi

if ! "$GL" git --staged --no-banner --redact; then
  echo "" >&2
  echo "🚫 pre-commit blocked: gitleaks found a potential secret in your staged changes (above)." >&2
  echo "   • Move it to an env var / secret variable and re-stage, OR" >&2
  echo "   • If it is a confirmed false positive: git commit --no-verify" >&2
  exit 1
fi
exit 0
```

It fails open — if `gitleaks` is not installed, it exits 0 rather than blocking
commits — so a clean commit here is not by itself proof that a scan ran.

---

## 4. Continuous integration

CI is GitHub Actions, defined in `.github/workflows/`:

| Workflow | Purpose |
|---|---|
| `ci.yml` | Client, server, database-migration, Python-ingest and audio-worker jobs — lint, type-check, test, Docker image build, dependency audit |
| `gitleaks.yml` | Secret scanning in CI, mirroring the local pre-commit hook |

A migration to self-hosted Forgejo with its own runner is filed in the backlog
as **F-239**, currently blocked on that instance being available. Until then
GitHub Actions remains the CI system.

---

## 5. What this snapshot does not cover

Repository *configuration* in the Git sense only. It says nothing about
application configuration — environment variables, `Deploy/.env`, the
`docker-compose.yml` service topology, or the blue/green deployment layout. Those
are described in `CLAUDE.md` and the `Deploy/` scripts, and the environment files
themselves are untracked and contain real secrets.
