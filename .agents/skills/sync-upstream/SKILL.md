---
name: sync-upstream
description: One-click sync — fetch upstream (source repo), rebase current branch, and push to your fork. Use when you want to pull the latest changes from the upstream OpenClaw repo.
user_invocable: true
---

# Sync Upstream

Pull latest code from the upstream (source) OpenClaw repo and push to your fork.

## Steps

1. Run `scripts/sync-upstream.sh` (defaults to `main` branch).
2. If a branch name is provided as an argument, sync that branch instead.
3. Report the result — new commits pulled, conflicts if any.

## Prerequisites

Remotes must be set up:

- `upstream` → source repo (`openclaw/openclaw`)
- `origin` → your fork

If not configured, the script will print setup instructions.
