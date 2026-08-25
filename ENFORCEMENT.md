# Enforcement — make the contract gate actually block merges

R1 built the gate; it posts a Check Run but **nothing blocks a merge until you make that check
required**. This is the step that takes a repo from *advisory* to *merge-blocked*.

## From "advisory" to "merge-blocked" — exactly what a consumer must do

1. **Add the workflow.** Copy [`examples/contract-gate.yml`](examples/contract-gate.yml) to
   `.github/workflows/contract-gate.yml` in your repo. Set the `CODERIFTS_API_KEY` secret.
2. **Open one PR** so the check runs at least once (GitHub only lists a check as "required-able"
   after it has been seen).
3. **Mark the check required** — UI or API below.
4. **Close the bypasses** — strict + include-administrators (below).

Until step 3, the check is **advisory**: it shows red/green but does not block.

## The stable check-name contract (the #1 misconfiguration)

The required status check context string must be **EXACTLY**:

```
CodeRifts / contract-gate
```

This is the hardcoded `CHECK_NAME` in `src/check-run.js` (not derived from any input, cannot vary).
The check-run **name** is what branch protection matches — **not** the workflow name and **not** the
job name.

> ⚠️ **If the required-check context does not byte-match the posted name, branch protection silently
> never blocks** — the required check stays perpetually "expected / pending" against a check that,
> by that name, never reports, and depending on settings the PR either can't merge (confusingly) or
> merges without the gate. Copy the string above verbatim (note the spaces around the `/`).

## (a) UI steps

**Settings → Branches → Branch protection rules → Add rule** (or edit the rule for your default
branch):

1. **Branch name pattern**: `main` (or your protected branch).
2. Check **Require status checks to pass before merging**.
3. Check **Require branches to be up to date before merging** (this is `strict` — see "fail-closed
   on absence" below).
4. In the search box, add: **`CodeRifts / contract-gate`**.
5. Check **Do not allow bypassing the above settings** / **Include administrators** (see SECURITY.md).
6. **Create / Save changes**.

## (b) API / script path (automatable)

One-liner via the provided script (reads existing protection, adds our context, sets strict +
admin-enforced):

```bash
scripts/require-contract-gate.sh <owner> <repo> main
```

Or the raw `gh api` call:

```bash
gh api -X PUT repos/{owner}/{repo}/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["CodeRifts / contract-gate"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

Verify it took:

```bash
gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks --jq '.contexts'
# => ["CodeRifts / contract-gate"]
```

## Fail-closed on absence — the workflow MUST run on every PR

GitHub enforces a required check **only if the check actually runs and reports**. Two ways this
silently fails open, and how to close each:

- **Path filters skip contract PRs.** If the workflow has `on: pull_request: paths: [...]` and a PR
  doesn't match, the workflow never runs, the check never reports, and — without `strict` — the PR
  can merge with the check "pending". **Close it:** the example workflow has **no `paths:` filter**
  (runs on every PR). Do not add one.
- **Stale branch merged before re-check.** A PR based on an old base could merge without re-running
  against the current base. **Close it:** `required_status_checks.strict = true` ("Require branches
  to be up to date") forces the branch current and the check to re-report before merge.

**Exact settings that close the absence gap:** required check `CodeRifts / contract-gate` +
`strict: true` + workflow triggers on `pull_request` with **no path filter**.

## Follow-up (server-side, not this round)

`coderifts-app/src/renderers/policy-renderer.js:88` still emits *"Approval requirements are
informational — configure GitHub branch protection rules to enforce them."* Once this gate is the
recommended enforcement path, that message could link here. Left as a server-side follow-up — R2
makes no server changes.

## Store-side grant coverage (`require-grant`, default false)

With `require-grant: true` the gate BLOCKS unless every changed governed path is covered by a
valid `cr.exec.v1` grant bound to this repository and operation. The claim it supports is about
the change set, never about the agent:

> Every mutation that reached protected path X in this window carries a valid grant, or is on the
> exception list.

The grant is verified **offline** before its coverage is considered: the token is parsed as
`cr.exec.v1`, its `kid` resolved against the pinned `grant-keyring` (no network fetch, ever), its
Ed25519 signature checked, and its `exp`/`iat` evaluated with the shipped clock-skew leeway. The
governed set is **derived** from the same diff the gate already reads, classified by the single
`@coderifts/contract-path` list.

**A retired key is never live permission for a grant.** This differs from receipts, where a
retired key inside its validity window is a passing historical class
(`RETIRED_KEY_VALID_AT_ISSUE`). A grant authorises a live execution, so a retired `kid` is
refused outright — the rule is taken from the app kernel, not inferred.

Failure classes are distinct on purpose — each has a different remedy: `grant_not_supplied` ·
`grant_does_not_cover_path` · `grant_bound_elsewhere` · `grant_expired` ·
`grant_signature_invalid` · `grant_key_retired` · `grant_malformed` · `grant_unverified` ·
`path_unreadable`. **`path_unreadable` is UNDECIDABLE and never treated as covered** — a blob we
cannot read cannot be hashed, so it cannot be shown to be covered.

### Residuals — true with the flag on, and not fixable from inside this Action

1. **An admin override still lands.** A repository admin with `enforce_admins: false` merges past
   every required check. The record of that lands in GitHub's own audit log — signed by a party we
   do not control, which is the point and also the limit.
2. **This check does not carry CodeRifts App identity.** It is posted with the workflow's
   `GITHUB_TOKEN`, so it is attributed to `github-actions[bot]`, not to our App. An actor who can
   edit `.github/workflows/` can change what runs and still post a green check under this name.
   **Govern those paths too** — `.github/workflows/**` and the branch-protection config are part
   of the protected surface, or this gate is advisory against that actor.
3. **Behaviour can change without touching the artifact.** A grant binds contract bytes. A change
   that leaves every governed file byte-identical passes this gate and can still change what the
   service does. Contract governance is not behaviour governance, and no amount of gate strictness
   closes that.
