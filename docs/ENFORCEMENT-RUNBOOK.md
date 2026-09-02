# Enforcement runbook — GitHub

A customer-runnable reference for making the gate's verdict actually block a merge, and for proving
it does. Every command is copy-pasteable; parameterised as `<owner>/<repo>` except where a value is
cited from our own demo repository as a worked example.

Written from a setup that was measured, not designed on paper: `coderifts/demo` was configured this
way and the readbacks below are its real values.

## 0. What you are building

Two bindings, and both are needed:

1. **name** — branch protection requires a check context by name.
2. **source** — the requirement names an `integration_id`, so only that integration satisfies it.

With only the first, any party that can write a check-run with that name satisfies the requirement.
That is the gap step 5 exists to demonstrate.

## 1. A dedicated enforcement App

Create a GitHub App under your organisation:

- **Permissions:** Repository → Checks: **Read and write**. Nothing else.
- **Webhook:** unchecked. This App never receives events; it only posts check runs.
- Install it on the repositories you intend to enforce.

Note its **App ID** — it is the `integration_id` in step 3.

```bash
# The installation's app id, as the API reports it:
gh api /repos/<owner>/<repo>/installations --jq '.installations[] | {app_id, app_slug}'
```

> Our demo does not use a dedicated App: it is enforced by the **Action**, whose check runs are
> posted by GitHub Actions itself — `integration_id 15368`. Both shapes work. A dedicated App is
> for when you want the check attributable to an identity you control rather than to the shared
> Actions identity, which any workflow in the repository also carries.

## 2. Branch protection: required check, strict, enforce_admins

```bash
OWNER_REPO=<owner>/<repo>
BRANCH=main
CONTEXT='CodeRifts / contract-gate (Action)'   # or your dedicated App's check name

gh api -X PUT "repos/$OWNER_REPO/branches/$BRANCH/protection" --input - <<JSON
{
  "required_status_checks": {
    "strict": true,
    "checks": [{ "context": "$CONTEXT", "app_id": 15368 }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

`strict: true` requires the branch to be up to date, so a green check on a stale head does not carry
a merge. `enforce_admins: true` is the difference between a policy and a suggestion — without it an
administrator merges past everything below.

Read back what was actually stored, because `app_id` is the field that silently does not take:

```bash
gh api "repos/$OWNER_REPO/branches/$BRANCH/protection" \
  --jq '{checks: .required_status_checks.checks, strict: .required_status_checks.strict, admins: .enforce_admins.enabled}'
```

Measured on `coderifts/demo`, 2026-09-02:

```json
{"admins":true,"checks":[{"app_id":15368,"context":"CodeRifts / contract-gate (Action)"}],"strict":true}
```

An `app_id` of `null` here means name-only matching. Do not proceed to production on that state.

## 3. A ruleset with the integration binding

Branch protection and rulesets are separate systems and can both be active. The ruleset is where the
binding is expressed in a form you can version and review.

```bash
gh api -X POST "repos/$OWNER_REPO/rulesets" --input - <<'JSON'
{
  "name": "coderifts-enforcement",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "CodeRifts / contract-gate (Action)", "integration_id": 15368 }
        ]
      }
    }
  ]
}
JSON
```

That body is the one in force on `coderifts/demo` (ruleset id `22074842`), reproduced from its
readback. Substitute your own context and `integration_id`.

## 4. Readback proof

```bash
node scripts/readback.js <owner>/<repo> <pr-number> --expect-app <your-app-slug>
```

What a correctly bound repository looks like:

```
required context: "CodeRifts / contract-gate (Action)"
  source-bound:   yes (app_id 15368)
  readback:       EXACT
  posted by:      github-actions (app_id 15368) -> failure
```

- **EXACT** — one poster carries that exact name. This is what you want.
- **INDETERMINATE** — several do, and which one satisfied the requirement cannot be read back.
- **ABSENT** — nobody posted it.

`source-bound: NO — name-only match` means step 2 or 3 did not take. Fix that before trusting any
green.

## 5. The negative test

Do not skip this. It is the only step that demonstrates the binding rather than asserting it: post a
check-run with the required name, `conclusion: success`, from a **different identity**, and observe
whether the pull request becomes mergeable.

The procedure — commands, teardown, and how to record the result — is in
[`test/negative-provider-enforcement.md`](../test/negative-provider-enforcement.md). Run it on a
scratch branch; it deliberately posts a success that nothing verified.

Record the outcome as `negative_test.status` in `provider-enforcement-result.v1`:
**PASSED** (the foreign poster could not satisfy it) or **FAILED** (it could).

## 6. What this does and does not prove

**Closed by the source binding.** The name collision. With `integration_id` set, a check-run
carrying the required name from another integration does not satisfy the requirement. Our own demo
runs both the App and the Action posting similar names; only the bound one counts.

**Closed by the platform.** A user access token cannot forge a check run under an App's identity —
`POST /repos/.../check-runs` with a PAT is refused. The check-run's `app` is assigned by GitHub from
the credential, not by the caller.

**Not closed: administrative discipline.** A repository or organisation administrator can edit the
ruleset, lower `enforce_admins`, or delete the branch protection — and then merge. Nothing in this
runbook prevents that, and no configuration on this platform can: the settings that enforce the rule
are editable by the people the rule applies to. **Enforcement here is as strong as your admin
discipline.** If that is not strong enough for your case, the controls that help are outside
GitHub's branch settings: restricting who holds admin, requiring review on ruleset changes, and
alerting on ruleset modification events.

**Not closed: what the check means.** A green required check says the gate reported success for that
head. It does not say the change is safe, that the executor behaved, or that anything downstream
honoured the decision. Those are separate proofs with separate evidence.

**Not closed: unbound workflows.** When the binding is `integration_id 15368` — GitHub Actions —
any workflow in the repository satisfies it, because they all post under that same integration. A
dedicated App (step 1) narrows this; a SHA-pinned required workflow narrows what runs but not what
may post. Both are needed to say "this workflow's verdict".
