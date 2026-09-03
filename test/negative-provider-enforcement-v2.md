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

On `coderifts/demo`, **2026-09-03, AFTER the rebind**:

```console
$ gh api repos/coderifts/demo/rulesets/22074842 --jq '...'
enforcement: active | bypass_actors: [] | strict: true
  REQUIRED: context='CodeRifts / contract-gate'  integration_id=2860592

$ gh pr view 4 -R coderifts/demo --json state,mergeStateStatus
PR#4 state: OPEN | mergeStateStatus: BLOCKED

$ gh api "repos/coderifts/demo/commits/be22b752575d/check-runs"
  CodeRifts / contract-gate (Action)   app=15368/github-actions  failure
  contract-gate (Action)               app=15368/github-actions  failure
  CodeRifts / contract-gate            app=2860592/coderifts     failure   ← the required one
```

**What PR#4 proves, and what it does not.** It proves the required check is *present and bound*:
the ruleset names `2860592`, the App posted under that identity, and the PR is BLOCKED. But the
App's check is **`failure`** — so the block is explained by the verdict alone. Nothing yet shows
that a check from a *different* issuer would be **excluded**. Presence is not exclusion, and that
gap is what this procedure closes.

**Why an empty PR cannot be the subject.** Measured in the app
(`src/mergegate/webhook-integration.js:493`): when no contract file changed, the conclusion is
`enforce ? 'success' : 'neutral'` — and per that file's own correction, **neutral PASSES a required
check**. So on a PR with no contract change the App posts a passing check and the requirement is
satisfied before the impostor is even considered. The subject must be a PR where the App's check
is `failure`. PR#4 already is one.

**The ordering trap, and why it decides the test.** GitHub takes the LATEST check-run for a given
name. If the impostor posts `success` under the required name *before* the App posts `failure`,
the App simply overwrites it and the PR blocks for the ordinary reason — proving nothing. The
impostor must post **after** the App's failure is already on the head. Then exactly one of two
things is true:

* the requirement is matched by **issuer** → the App's `failure` still governs → **BLOCKED**
* the requirement is matched by **name** → the impostor's `success` governs → **CLEAN**

## Preconditions

- Admin on `coderifts/demo` (to push a workflow to the scratch branch; no ruleset write is needed).
- The rebind is in place: `{context: "CodeRifts / contract-gate", integration_id: 2860592}`.
- **PR#4 is the subject.** Its head already carries the App's `failure` under the required name.
  Nothing about the ruleset changes, which is why this run is far less destructive than v1.

## Procedure

**Step 1 — record the starting state** (non-destructive)

```console
$ gh api repos/coderifts/demo/rulesets/22074842 > /tmp/ruleset-before.json
$ gh pr view 4 -R coderifts/demo --json mergeStateStatus     # expect: BLOCKED
$ H=$(gh pr view 4 -R coderifts/demo --json headRefOid --jq .headRefOid)
$ gh api "repos/coderifts/demo/commits/$H/check-runs" --jq '.check_runs[]|{name,app:.app.id,conclusion}'
```
Record which check-runs exist and their conclusions. The App's `CodeRifts / contract-gate` must be
`failure` before you continue — if it is not, this is not the subject the test needs.

**Step 2 — add the impostor workflow to PR#4's branch** (DESTRUCTIVE: pushes to the PR branch)

A PAT does **not** reproduce the condition: a check-run posted with a personal token carries no
`app.id` at all, so the requirement would fail it for the wrong reason and the test would report a
pass it did not earn. It must be a real workflow, so the check-run carries `app.id: 15368`.

```yaml
# .github/workflows/neg-v2-impostor.yml   — on branch feat/breaking-changes-v1.5 ONLY
name: neg-v2-impostor

# Manual only. `on: pull_request` would race the App's own check and destroy the ordering the
# test depends on (see "The ordering trap" above).
on: workflow_dispatch

permissions:
  checks: write

jobs:
  impostor:
    runs-on: ubuntu-latest
    steps:
      - name: Post a SUCCESS under the required name, as the generic Actions issuer
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          HEAD_SHA: ${{ github.event.inputs.head_sha }}
        run: |
          curl -sS -X POST "$GITHUB_API_URL/repos/${{ github.repository }}/check-runs" \
            -H "Authorization: Bearer $GH_TOKEN" \
            -H "Accept: application/vnd.github+json" \
            -H "X-GitHub-Api-Version: 2022-11-28" \
            -d "{
                  \"name\": \"CodeRifts / contract-gate\",
                  \"head_sha\": \"$HEAD_SHA\",
                  \"status\": \"completed\",
                  \"conclusion\": \"success\",
                  \"output\": {
                    \"title\": \"IMPOSTOR — not the gate\",
                    \"summary\": \"Posted by a generic Actions workflow (15368) under the required name. If this satisfies the requirement, the issuer binding is decorative.\"
                  }
                }"
```

```console
$ git checkout feat/breaking-changes-v1.5
$ mkdir -p .github/workflows && cp neg-v2-impostor.yml .github/workflows/
$ git add .github/workflows/neg-v2-impostor.yml
$ git commit -m "negative test v2 impostor — REMOVE AFTER THE RUN"
$ git push
```

**Step 3 — fire it, after confirming the App's failure is already on the head**

```console
$ gh workflow run neg-v2-impostor.yml -R coderifts/demo \
    --ref feat/breaking-changes-v1.5 -f head_sha="$H"
$ sleep 20
$ gh api "repos/coderifts/demo/commits/$H/check-runs" \
    --jq '.check_runs[]|select(.name=="CodeRifts / contract-gate")|{app:.app.id,conclusion,started:.started_at}'
```

Expected: **two** entries under the required name — `2860592/failure` and `15368/success` — with
the impostor's timestamp later. If only one appears, the impostor did not land and step 4 is void.

**Step 4 — the measurement**

```console
$ gh pr view 4 -R coderifts/demo --json mergeStateStatus,statusCheckRollup
$ GITHUB_TOKEN=$(gh auth token) node scripts/readback.js coderifts/demo 4 \
    --expect-app coderifts --result | jq '.ruleset_binding.cross_check, .readback'
```

| Observation | Verdict |
|---|---|
| `mergeStateStatus: BLOCKED` **and** readback shows both posters | **PASS — issuer exclusion proven.** A legitimate Actions workflow posted `success` under the exact required name and the requirement was still not satisfied. This is the claim PR#4 alone could not support. |
| `mergeStateStatus: CLEAN` | **FAIL.** Name matching won: the `integration_id` on the ruleset is decorative, and any workflow author can green the gate. |
| only one check-run under the name | **VOID.** The impostor did not post, or overwrote rather than coexisting. Re-run; do not record a result. |

**Step 5 — the positive control** (without it, step 4 only shows that *something* blocked)

Push a fix to PR#4 so the App's own check concludes `success`, and confirm `mergeStateStatus`
becomes `CLEAN`. If step 4 blocked and step 5 does not unblock, the ruleset is refusing everything
and the "exclusion" in step 4 was not about the issuer at all.

**Step 6 — restore** (mandatory)

```console
$ git rm .github/workflows/neg-v2-impostor.yml && git commit -m "remove impostor" && git push
$ gh api repos/coderifts/demo/rulesets/22074842 --jq '.rules'   # unchanged; nothing to restore
```
The impostor check-run stays on the head permanently — GitHub does not delete check-runs. Its
`output.title` says `IMPOSTOR — not the gate` for exactly that reason.

## What this proves that PR#4 did not

PR#4 shows the required check is **present, bound, and failing**, and that the PR is BLOCKED. Every
part of that is consistent with a name-only requirement: the App happened to post, and it happened
to fail. This procedure holds the name constant and varies **only the issuer**, so a BLOCKED result
can no longer be explained by the verdict. That is the difference between *presence* and
*exclusion*, and exclusion is the property both auditors asked for.

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
