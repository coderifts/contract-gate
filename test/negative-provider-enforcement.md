# Negative test: does the required check bind to a source?

A runnable procedure. It answers one question: **when branch protection requires a check by name,
can a party other than the gate satisfy it?**

Everything here is `gh` only. Steps 1 and 4 change branch protection on a scratch branch and need
admin on the repository; steps 2, 3 and 5 do not.

> Run this on a scratch branch, never on `main`. Step 2 posts a check-run that claims success for a
> change nothing verified — that is the point of the test, and it is also why it must not run
> against a branch anyone merges from.

## What was measured before writing this

On `coderifts/demo`, 2026-09-01:

```console
$ gh api repos/coderifts/demo/branches/main/protection --jq '.required_status_checks.checks'
[{"context":"CodeRifts / contract-gate","app_id":null}]

$ gh api repos/coderifts/demo/rulesets
[]

$ gh api repos/coderifts/demo/branches/main/protection --jq '.enforce_admins.enabled, .required_status_checks.strict'
false
false
```

`app_id: null` is the whole finding: the requirement records **no** app binding. GitHub matches the
required context by **name**. On the same PR head, three check-runs existed under two apps:

```console
$ gh api repos/coderifts/demo/commits/<head>/check-runs \
    --jq '.check_runs[] | "\(.name)\t\(.conclusion)\tapp=\(.app.slug)/\(.app.id)"'
CodeRifts / contract-gate (Action)   failure   app=github-actions/15368
contract-gate (Action)               failure   app=github-actions/15368
CodeRifts / contract-gate            failure   app=coderifts/2860592
```

## Procedure

### 1. Require the Action's check on a scratch branch (admin)

```bash
REPO=coderifts/demo
BRANCH=scratch/enforcement-negative-test
CONTEXT='CodeRifts / contract-gate (Action)'

gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
  --input - <<JSON
{
  "required_status_checks": { "strict": false, "contexts": ["$CONTEXT"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON

# Read back what was actually stored — in particular whether app_id came out null.
gh api "repos/$REPO/branches/$BRANCH/protection" --jq '.required_status_checks.checks'
```

Expected: `[{"context":"CodeRifts / contract-gate (Action)","app_id":null}]`.

### 2. Post the same name from a different identity

Open a PR from `$BRANCH`, let the Action run and **fail**, then post a check-run with the same name
and `conclusion: success` from a second identity — another PAT, or a token from a different GitHub
App installation. Any token with `checks:write` on the repository will do; the identity that posts
is recorded as the check-run's `app`, and step 1 bound nothing to it.

```bash
PR=<number>
HEAD=$(gh pr view "$PR" --repo "$REPO" --json headRefOid -q .headRefOid)

GH_TOKEN=$OTHER_IDENTITY_TOKEN gh api -X POST "repos/$REPO/check-runs" \
  -f name="$CONTEXT" \
  -f head_sha="$HEAD" \
  -f status=completed \
  -f conclusion=success \
  -f output[title]='negative test' \
  -f output[summary]='Posted by a party that verified nothing.'
```

### 3. Read back

```bash
gh pr view "$PR" --repo "$REPO" --json mergeStateStatus,statusCheckRollup \
  --jq '{merge: .mergeStateStatus, checks: [.statusCheckRollup[] | {name, conclusion}]}'

gh api "repos/$REPO/commits/$HEAD/check-runs" \
  --jq '.check_runs[] | "\(.name)\t\(.conclusion)\tapp=\(.app.slug)/\(.app.id)"'

node scripts/readback.js "$REPO" "$PR" --expect-app github-actions
```

**Expected on name-only matching: the PR becomes mergeable.** `mergeStateStatus` leaves `BLOCKED`
even though the Action's own run for that head is still `failure`, because the required context was
satisfied by name and the failing run carries a different one — or, if both carry the same name, by
whichever the rollup resolves to. `scripts/readback.js` reports the context as
`source-bound: NO — name-only match`, `INDETERMINATE` when two posters share the name, and
`posted_by_expected_app: false`.

Record the result as `negative_test.status` in `provider-enforcement-result.v1`:

- **FAILED** — the PR became mergeable on a check the gate did not post. The requirement is
  name-only.
- **PASSED** — the PR stayed blocked. Something bound the requirement to a source; capture what.

### 4. Repeat with a source binding (admin)

```bash
APP_ID=$(gh api "repos/$REPO/commits/$HEAD/check-runs" \
  --jq '[.check_runs[] | select(.name=="'"$CONTEXT"'")][0].app.id')

gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
  --input - <<JSON
{
  "required_status_checks": {
    "strict": false,
    "checks": [{ "context": "$CONTEXT", "app_id": $APP_ID }]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

Repeat step 2 from the other identity and read back again. A check posted by a different `app_id`
should no longer satisfy the requirement.

### 5. Tear down

```bash
gh api -X DELETE "repos/$REPO/branches/$BRANCH/protection"
gh pr close "$PR" --repo "$REPO" --delete-branch
```

## What each mode proves

| mode | what a green required check proves | what it does not |
|---|---|---|
| name-only (`app_id: null`) | some party posted that name with `success` | nothing about **who**, and nothing about what they verified |
| source-bound (`app_id` set) | the check came from that app installation | not which workflow inside it ran, and not that the workflow was the reviewed one |
| SHA-pinned required workflow | a specific workflow file at a specific commit ran | not that another party did not also post the same context name, unless the context is **also** source-bound |

The third row is the one most often over-read: pinning the workflow by SHA constrains **what runs**,
not **what may post**. A repository can pin the gate's workflow to a commit and still have the
required context satisfied by an unrelated poster, because those are two different bindings. Both
are needed for the requirement to mean "this workflow's verdict".

`enforce_admins: false` is orthogonal and applies to every row: a repository admin merges past all
of it. Record it as `bypass_policy.enforce_admins`.
