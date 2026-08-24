# Marketplace listing copy — CodeRifts Contract Gate

Paste-ready text for the GitHub Marketplace listing form. Every claim here is verified by a
test in this repo; do not add capability wording that is not.

## Name

CodeRifts Contract Gate

## Category

- Primary: **Code quality**
- Secondary: **Continuous integration**

## Description (≤3 sentences — the listing body)

> CodeRifts Contract Gate blocks a pull request from merging unless a signed ALLOW receipt
> verifies offline, against a keyring pinned inside the action, for the change set derived from
> the PR's actual head diff. It never fetches the verification key from the server that issued
> the receipt, and it fails closed on a missing, tampered, expired, unknown-key, or
> wrong-head receipt. Mark the `CodeRifts / contract-gate` check as required in branch
> protection to make the gate an enforcement point rather than an advisory comment.

## Tagline (action.yml `description`, shown on the card)

> Blocks a merge unless a signed ALLOW receipt verifies offline against a pinned keyring for
> the PR's actual head diff. With require_verified_monitoring: true the gate blocks CWM without
> delivery evidence; by default it passes CWM on the host's claim.

## What NOT to claim

- Not "inescapable" or "atomic". A repository admin with `enforce_admins: false` can still
  merge — the residual is documented in [SECURITY.md](SECURITY.md).
- Not "monitoring verified" by default. With `require_verified_monitoring: true` the gate
  blocks CWM without delivery evidence; by default it passes CWM on the host's claim.
- Not "blocks merges" on its own. It posts a Check Run; blocking requires the check to be
  marked **required** in branch protection ([ENFORCEMENT.md](ENFORCEMENT.md)).
- Not "detects all breaking changes". The pass condition is *a signed ALLOW for this exact
  diff*, not *breaking == 0*.

## Pre-submission facts

| Field | Value | Source |
|-------|-------|--------|
| Action entrypoint | `src/index.js`, `node20` | `action.yml` |
| Ref used in docs | `coderifts/contract-gate@v0` | `README.md` |
| Check Run name | `CodeRifts / contract-gate` | `src/check-run.js` (pinned by `test/enforcement-docs.test.js`) |
| Branding | `icon: lock`, `color: blue` | `action.yml` |
| License | MIT | `LICENSE` |
| Required permissions | `checks: write`, `contents: read` | `README.md` usage block |
| Required setup | `actions/checkout` with `fetch-depth: 0` | `action.yml` comment |
