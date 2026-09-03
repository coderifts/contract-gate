# Negative test v2: does an *issuer-bound* required check exclude other issuers?

The v1 test answered "can a party other than the gate satisfy a **name-only** requirement?" — yes.
This one answers the sharper question both external auditors asked next:

> Once the required check is bound to a specific `integration_id`, does a check-run of the **same
> name** from a **different, legitimate** Actions workflow under the generic Actions issuer
> (`integration_id: 15368`) still satisfy it?

The distinction matters because the v1 remedy — "bind the check to an app" — is worthless if the
app it binds to is the *shared* GitHub Actions identity. Every workflow in the repository runs
under `15368`. Anyone who can write `.github/workflows` can post under it. Binding to `15368` looks
like an issuer binding and is not one.

**DESTRUCTIVE.** Steps 2 and 4 change ruleset state; step 3 posts a check-run claiming success for
a change nothing verified. Run on a scratch branch, never on `main`, and restore in step 6. Like
v1, the result is **carried with its date** into `provider-enforcement-result.v1.json`
(`negative_test.observed_at`) rather than re-run by the producer — `scripts/readback.js` is
read-only and must never perform this.

## What was measured before writing this

On `coderifts/demo`, **2026-09-03**:

```console
$ gh api repos/coderifts/demo/rulesets/22074842 --jq '.enforcement, .bypass_actors, [.rules[]|select(.type=="required_status_checks").parameters.required_status_checks]'
"active"
[]
[[{"context":"CodeRifts / contract-gate (Action)","integration_id":15368}]]

$ H=$(gh pr view 13 -R coderifts/demo --json headRefOid --jq .headRefOid)
$ gh api "repos/coderifts/demo/commits/$H/check-runs" --jq '.check_runs[]|{name,app:.app.id}'
{"name":"CodeRifts / contract-gate","app":2860592}
```

Two findings, and the second is the one that blocks this test today:

1. The ruleset binds to **15368** — the generic Actions issuer, not a dedicated app.
2. **Nothing posts the required context.** The ruleset requires
   `CodeRifts / contract-gate (Action)`; every check-run observed is named
   `CodeRifts / contract-gate` (no ` (Action)` suffix), from app **2860592**. The required name has
   never appeared on any PR head in this repository.

Finding 2 means the gate is currently **permanently pending**, not enforcing — which looks like
enforcement from the merge button and is not the same thing. The ruleset was created 2026-09-02;
the last merges (PR#12, PR#13) were 2026-08-27, i.e. **before** it existed, so no merge has yet
been evaluated against it.

## Preconditions

- Admin on `coderifts/demo` (ruleset writes).
- The rebind from `docs/ruleset-rebind-2860592.json` has been applied, so the requirement is
  `{context: "CodeRifts / contract-gate", integration_id: 2860592}`.
- A scratch branch `neg-v2` off `main`, and a PR from it.

## Procedure

**Step 1 — record the starting state** (non-destructive)

```console
$ gh api repos/coderifts/demo/rulesets/22074842 > /tmp/ruleset-before.json
$ jq '[.rules[]|select(.type=="required_status_checks").parameters.required_status_checks]' /tmp/ruleset-before.json
```
Expected: one entry, `context: "CodeRifts / contract-gate"`, `integration_id: 2860592`.

**Step 2 — create the scratch PR** (non-destructive to `main`)

```console
$ git checkout -b neg-v2 && git commit --allow-empty -m "negative test v2" && git push -u origin neg-v2
$ gh pr create -R coderifts/demo --base main --head neg-v2 --title "negative test v2" --body "destructive test; do not merge"
$ H=$(gh pr view --json headRefOid --jq .headRefOid)
```

**Step 3 — post the impostor check from the generic Actions issuer** (DESTRUCTIVE)

The impostor must be a *legitimate* workflow in the repository, so that its check-run genuinely
carries `app.id: 15368` — a check-run posted with a PAT does **not** reproduce the condition,
because it carries no app id at all and would pass the test for the wrong reason.

```yaml
# .github/workflows/neg-v2-impostor.yml  (on the scratch branch only)
name: neg-v2-impostor
on: pull_request
permissions: { checks: write }
jobs:
  impostor:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST "$GITHUB_API_URL/repos/${{ github.repository }}/check-runs" \
            -H "Authorization: Bearer ${{ secrets.GITHUB_TOKEN }}" \
            -H "Accept: application/vnd.github+json" \
            -d '{"name":"CodeRifts / contract-gate","head_sha":"${{ github.event.pull_request.head.sha }}","status":"completed","conclusion":"success","output":{"title":"IMPOSTOR","summary":"posted by a generic Actions workflow, not the gate"}}'
```

Confirm it landed under the generic issuer — this is the assertion the test turns on:

```console
$ gh api "repos/coderifts/demo/commits/$H/check-runs" --jq '.check_runs[]|{name,app:.app.id}'
{"name":"CodeRifts / contract-gate","app":15368}     # ← impostor, generic Actions
```

**Step 4 — read the merge state** (the actual measurement)

```console
$ gh pr view --json mergeStateStatus,statusCheckRollup
$ node scripts/readback.js coderifts/demo <PR> --expect-app coderifts --result | jq .ruleset_binding
```

| Outcome | Meaning |
|---|---|
| `mergeStateStatus: BLOCKED` **and** `ruleset_binding.cross_check[].agreement == "POSTED_BY_OTHER_ISSUER"` | **PASS.** The binding excludes the generic issuer. This is the result the auditors asked for. |
| `mergeStateStatus: CLEAN` | **FAIL.** A generic Actions workflow satisfied an app-bound requirement — the binding is decorative. |
| `agreement == "BOUND_ISSUER_POSTED"` | **INVALID RUN.** The real gate also posted; the impostor was not isolated. Re-run with the gate disabled for this PR. |

The third row exists because the test is only meaningful when the impostor is the *only* poster of
that name. A run where both posted proves nothing and must not be recorded as a pass.

**Step 5 — the positive control** (without it, step 4 proves only that something was blocked)

Let the real gate post on the same head. Expected: `mergeStateStatus` becomes `CLEAN` and
`agreement == "BOUND_ISSUER_POSTED"`. If step 4 blocked and step 5 does not unblock, the ruleset is
rejecting everything and the "exclusion" in step 4 was not about the issuer.

**Step 6 — restore** (mandatory)

```console
$ gh api -X PUT repos/coderifts/demo/rulesets/22074842 --input /tmp/ruleset-before.json
$ gh pr close <PR> --delete-branch
```

## Recording the result

Into `provider-enforcement-result.v1.json`:

```json
"negative_test": {
  "id": "issuer-binding-excludes-generic-actions",
  "result": "PASSED | FAILED | NOT_RUN",
  "observed_at": "<ISO date of the run>",
  "procedure": "test/negative-provider-enforcement-v2.md — Recorded rather than re-run: destructive."
}
```

`NOT_RUN` is a real value and the honest one until this has actually been performed. A producer
that emitted `PASSED` for a destructive test nobody ran is the failure the schema exists to prevent.

## What this test does NOT prove

- That `2860592` cannot be impersonated by someone holding its private key. Binding is not custody.
- That an administrator did not change the ruleset immediately before merging. `bypass_actors: []`
  is read at one moment; it is configuration, not a run.
- That the gate's verdict was *correct* — only that the check which satisfied the requirement came
  from the bound issuer.
