#!/usr/bin/env bash
#
# Make "CodeRifts / contract-gate" a REQUIRED status check on a protected branch — the step that
# turns the gate from advisory into merge-blocking. Automatable alternative to the UI steps in
# ENFORCEMENT.md.
#
# Requires: gh (authenticated with admin on the repo).
# Usage:    scripts/require-contract-gate.sh <owner> <repo> [branch]   # branch defaults to main
#
# This PRESERVES any existing protection by reading the current rule and re-submitting it with our
# context added. It sets:
#   - required_status_checks.contexts includes "CodeRifts / contract-gate"
#   - strict = true  ("require branches to be up to date" — closes the stale-branch bypass)
#   - enforce_admins = true  ("include administrators" — closes admin bypass)
# Adjust enforce_admins to false if you intentionally want an admin escape hatch (NOT recommended
# for true enforcement — see SECURITY.md).

set -euo pipefail

OWNER="${1:?owner required}"
REPO="${2:?repo required}"
BRANCH="${3:-main}"
CONTEXT="CodeRifts / contract-gate"   # MUST match src/check-run.js CHECK_NAME exactly.

API="repos/${OWNER}/${REPO}/branches/${BRANCH}/protection"

# Read existing contexts (empty if no protection yet), then union our context in.
existing="$(gh api "${API}/required_status_checks/contexts" 2>/dev/null || echo '[]')"
contexts="$(printf '%s' "$existing" | jq --arg c "$CONTEXT" '. + [$c] | unique')"

# PUT the full protection object. required_pull_request_reviews/restrictions are left null (unchanged
# defaults); tune to your policy. The three enforcement-critical fields are set explicitly.
gh api -X PUT "$API" \
  -H "Accept: application/vnd.github+json" \
  --input - <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ${contexts} },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON

echo "OK: '${CONTEXT}' is now a required, strict, admin-enforced check on ${OWNER}/${REPO}@${BRANCH}"
echo "Verify: gh api ${API}/required_status_checks --jq '.contexts'"
