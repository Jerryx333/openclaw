#!/usr/bin/env bash
# Sync local main with upstream (source repo) and push to origin (your fork).
#
# Usage:
#   ./scripts/sync-upstream.sh          # sync main branch
#   ./scripts/sync-upstream.sh develop  # sync a different branch
#
# First-time setup (run once):
#   git remote rename origin upstream
#   git remote add origin git@github.com:YOUR_USERNAME/openclaw.git

set -euo pipefail

BRANCH="${1:-main}"
UPSTREAM="upstream"
ORIGIN="origin"

# --- Check remotes ---
if ! git remote | grep -q "^${UPSTREAM}$"; then
  echo "Error: remote '${UPSTREAM}' not found."
  echo ""
  echo "Set it up first:"
  echo "  git remote rename origin upstream"
  echo "  git remote add origin git@github.com:YOUR_USERNAME/openclaw.git"
  exit 1
fi

echo "Fetching ${UPSTREAM}..."
git fetch "${UPSTREAM}"

echo "Rebasing ${BRANCH} onto ${UPSTREAM}/${BRANCH}..."
git rebase "${UPSTREAM}/${BRANCH}"

# Push to fork if origin exists
if git remote | grep -q "^${ORIGIN}$"; then
  echo "Pushing to ${ORIGIN}/${BRANCH}..."
  git push "${ORIGIN}" "${BRANCH}"
else
  echo "No '${ORIGIN}' remote — skipping push."
fi

echo "Done."
