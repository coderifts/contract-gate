# Changelog

## Unreleased
- **An MCP client configuration named `.grok/config.toml` is never a contract**, as in `@coderifts/contract-path` (`contract-write.cjs:69`, app commit `2c7f503e`, P65). `src/contract-path.js:25` `MCP_CLIENT_CONFIG` gains the `|\.grok\/config\.toml` alternative; before, the pattern lacked it and `test/contract-path-mirror.test.js:48` (MIRROR) was red against the package.
- **Vendored core: receipt-verifier v1.0.3 → v1.2.1 (signed tag, peeled `e1a346b`).** `src/verify.js` and `src/verify-grant.js` are byte copies of the tag; the other ten pinned `.js` files were already byte-identical to it, `receipt-from-commit.js` included (`src/VENDOR.sha256`). The verdict changes this brings, by the receipt-verifier release that made them: 1.1.1 a v1–v3 receipt is not authorization (P66) and a non-string signed field is `MALFORMED`; 1.1.4 a receipt verified beside an envelope must be v4; 1.1.5 Ed25519 only, and the result names the key that verified; 1.1.6 `--as-of` audit evaluation, and expiry applies under a retired key; 1.1.7 strict JSON parse (duplicate keys, lone surrogates, non-finite numbers are `MALFORMED`), and in `verify-grant.js` a grant whose key has `revoked_at` refuses at every instant and grant bodies are parsed strictly; 1.1.8 an `--as-of` instant before the receipt's `ts` is `NOT_YET_VALID_AT_AS_OF`; 1.2.0 the RECEIPT_FORMAT §7.1 key-status order — a revoked key is `REVOKED_KEY` at every signing time (with `compromised_at` in the result) and wins over `retired_at`, `REVOKED_KEY_UNDECIDABLE` is withdrawn, and a retired key signed before `retired_at` with no time anchor is `RETIRED_KEY_UNANCHORED`: **valid:true → valid:false** (was `RETIRED_KEY_VALID_AT_ISSUE`). The xlang corpus is regenerated with the receipt-verifier generator.

## 0.11.9 — 2026-10-12
- **Sends control-plane artifacts; v4-only receipts; a control-plane-only diff can now go green with two bound approvals and red without them.** For every changed control-plane path the authorize request carries `{ id, type: "control_plane", before, after }` beside any contract artifacts. Paths come from `git diff -z --no-renames --name-only <base> <head>`, so a rename is a delete of the old path plus an add of the new one. Keys and signing material under `.coderifts/keys/`, `.coderifts/trust/`, `.coderifts/signing/`, and `.pem`/`.pub` under `.coderifts/` are sent as the path only (`before` and `after` are `""`); the file text is not read. The list is `src/control-plane.js`, the same list as coderifts-app `src/mergegate/control-plane.js` lines 58-100 (read 2026-10-12): top-level `.github/workflows/*.yml|yaml`, `.coderifts.yml`/`.yaml`, those key paths, `.coderifts/audit.yml|yaml`, `coderifts-audit.yml|yaml`, `keyring/pinned-keys.json`, a root `action.yml|yaml`, and `.github/actions/**`. A request missing `preflight_mode: authorize`, `repository`, `base`, `head`, or `operation: merge` is not sent (`invalid_context`, and the summary names the slot). The issued receipt is still judged by `judgeReceipt` (four-slot binding, v4-only). `REQUIRE_APPROVAL` or `BLOCK` is `receipt_not_allow`, and the title carries `CONTROL_PLANE_CHANGE`.

## 0.11.8 — 2026-10-11
- **A control-plane-only diff is not `no_contract_changes`.** `allChanged` is `git diff base...head --name-only` before `classify()` drops non-contract paths (`src/artifacts.js`). Those paths are classified by `src/control-plane.js`, the same list as coderifts-app `src/mergegate/control-plane.js` (`classifyControlPlanePath`; workflow files via `isWorkflowFile`, `/^\.github\/workflows\/[^/]+\.ya?ml$/`). DECISIONS.md, "A control-plane change is never neutral (2026-10-11)", names `.coderifts.yml`/`.coderifts.yaml`, `.github/workflows/*.yml|yaml`, `.coderifts/{keys,trust,signing}/` and `.pem`/`.pub` under `.coderifts/`, `.coderifts/audit.yml`, `coderifts-audit.yml`. The function also classifies `.coderifts/audit.yaml`, and so does this action. With no contract artifact and a control-plane path, the run takes the receipt path: `require-receipt-trailer: true` fails `receipt_trailer_required` before any call; an api-key calls the issuer and `judgeReceipt` binds `preflight_mode`, `repository`, `base`, and `head`; an issued `REQUIRE_APPROVAL` (`execution_action` `REQUEST_APPROVAL`) or `BLOCK` (`STOP`) is failure `receipt_not_allow`, and the title carries `CONTROL_PLANE_CHANGE`. No key fails `receipt_trailer_missing`. The step summary, the `control-plane-files` output, and the `post-check-run: false` log line name the files. A contract change beside a control-plane path stays on today's path, and the summary names the files. A README-only diff stays `no_contract_changes`. Until 0.11.7 the action was success on coderifts/demo PR #33 (head `2ca2aca2ccbb73c13c07f1bf10ac25de9f4d31ca`, comment-only `.github/workflows/contract-gate.yml`): reader check-run 114510055851 succeeded and never read the receipt; the issuer failed (114510017575, completed 2026-10-11T15:50:35Z, "have 0"; after review 5483938946 and `/rerun` comment 6110898348, 114512261388, completed 2026-10-11T16:01:42Z, "have 1"). The merge was held by the App check alone.

## 0.11.7 — 2026-10-11
- **The opt-out log line names the reason and the receipt id.** `post-check-run: false` logs `[check not posted — post-check-run:false] <conclusion>: <title> reason=<reason> receipt-id=<id or n/a>`. A STOP (`receipt_not_allow`) and a binding mismatch share the title `Blocked — no verified receipt on the head commit`. The reason was only in `GITHUB_STEP_SUMMARY`, which the check-run API does not expose. A missing id prints `n/a`.
- **`examples/contract-gate.yml` pins `actions/checkout` by commit.** `11d5960a326750d5838078e36cf38b85af677262` (`# v4`). On 2026-10-11 `git ls-remote` resolved `refs/tags/v4` to that commit.

## 0.11.6 — 2026-10-11
- **The enforcing reader binds the receipt to this run.** After the digest check, `judgeReceipt` compares `preflight_mode`, `repository`, `base`, and `head` with `mismatchReason` (`src/gate.js`). A mismatch is `mode_mismatch`, `repo_mismatch`, `base_mismatch`, or `head_mismatch`, and it is a failure, not the missing-trailer fall-through. A trailer or sidecar skips a slot only when that slot is unbound. An issued receipt always compares all four, so a missing slot fails closed. On `merge_group`, `base_mismatch` or `head_mismatch` with `require-receipt-trailer` left false falls through to issuance for the queue SHAs. `repo_mismatch` and `mode_mismatch` stay failures. With the flag true, a mismatch stays a failure.
- **`require-receipt-trailer: true` fails closed before preflight.** No verifying trailer or sidecar posts `failure` with reason `receipt_trailer_required`, on every profile, and the preflight fetch is not called. The default stays `false`: on the enforcing profile a missing trailer still falls through to issuance, and a missing key still fails `receipt_trailer_missing`.
- **The action job shows the receipt.** It appends the five receipt lines, the conclusion, the receipt id (`envelope.receipt_id` when set, otherwise `envelope.decision_id`), `target_id`, `expires_at`, and the reason to `GITHUB_STEP_SUMMARY`, and sets outputs `receipt-id`, `conclusion`, `reason`, and `title`. The example aggregator prints those outputs. A job check-run's `output` cannot be set by this step. `post-check-run: false` still writes the summary and the outputs; it only skips the check-run POST.
- **The suggested workflow's permissions are `contents: read` and `pull-requests: read`.** `checks: write` stays commented, for the variant that posts its own check. The action reads the diff with local `git` (`src/artifacts.js`) and, only when it posts, `POST /repos/{owner}/{repo}/check-runs` (`src/check-run.js`). It does not call the pulls API. The SHAs come from `GITHUB_EVENT_PATH`.
- **README "Where it stops".** A fork pull request receives no `CODERIFTS_API_KEY`, so nothing is issued and the run fails closed unless the head carries a verifying trailer. The Actions-posted required context uses the workflow `GITHUB_TOKEN` (`src/gate.js`), so anyone who can edit `.github/workflows/` can turn it green. That is why `CodeRifts / issuer` is the second required check. Put CODEOWNERS on `.github/workflows/**` and, where the org has one, an org-level required workflow. `pull_request_target` is not used and not recommended.

## 0.11.5 — 2026-10-09
- **A plain `mcp.json` that is both an MCP client configuration and a tool manifest, or that does not parse, is not
  read or sent, and the run fails with one sentence (outcome `MCP_JSON_HELD`).** It is not a contract artifact and
  not "no contract change": split the server list and the tool manifest into separate files, or make the file valid
  JSON (no comments) to have it checked. The vendored classifier mirrors @coderifts/contract-path 1.3.1; the mirror
  test holds it to the package on the shared vectors.

## 0.11.4 — 2026-10-08
- **A plain `mcp.json` is decided by its content (P65c).** v0.11.3 refused every `mcp.json` by name, and that is
  also the name a server's tool manifest carries (coderifts.com's own): a PR that removed a tool from one passed
  `no_contract_changes`. By name the Action now refuses only `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
  `claude_desktop_config.json` and `(cline_)mcp_settings.json` (never read). Any other `mcp.json` is read with
  `git show` and decided as @coderifts/contract-path 1.3.0 decides it: `mcpServers` / `servers` and no `tools` →
  an MCP client configuration, counted as no file and never sent; `tools`, any other shape, or text that does not
  parse → a contract (fail-closed). A manifest turned into a client configuration is the manifest removed. The
  vendored copy is held to the package on a corpus by the mirror test.

## 0.11.3 — 2026-10-06
- **An MCP client configuration is never read or sent (P65).** `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
  `mcp_settings.json`, `cline_mcp_settings.json`, `.mcp.json`, `claude_desktop_config.json` are not contract artifacts:
  `classify()` refuses @coderifts/contract-path's MCP_CLIENT_CONFIG first, so the file is not read from git and not
  sent to preflight. The vendored classifier mirrors the package's pattern character for character.

## Unreleased (after v0.11.0) — docs, example and tests

- **The reader's context is one string, carried by the measured-enforcing shape.** The example
  workflow's `if: always()` aggregator job is now named `CodeRifts / contract-gate` verbatim (it was
  `contract-gate (required)`, a name no doc told anyone to require), and the gate step runs with
  `post-check-run: 'false'` so one poster carries the name. `CHECK_NAME`, the `check-name` default,
  that job name, ENFORCEMENT.md and docs/ENFORCEMENT-RUNBOOK.md now say the same string beside
  `CodeRifts / issuer`.
- **Transition, stated where operators configure it:** the App no longer posts
  `CodeRifts / contract-gate`; a ruleset that required it bound to 2860592 moves to
  `CodeRifts / issuer` (2860592) plus `CodeRifts / contract-gate` (15368).
- `test/context-name-one-string.test.js` holds it.

## 0.10.0

- New optional input `require-receipt-trailer` (default `false`). When `true`, the head commit's receipt (trailer or sidecar) must verify offline against the pinned keyring, its `artifact_digest` must match the pull request's diff digest, and its `execution_action` must be `CONTINUE`; any failure is a failing check before the preflight call. A trailer alone (no envelope) fails with `receipt_envelope_required`.
- Vendored `receipt-from-commit.js` (byte-copy, pin `a209154`).

## 0.10.0

The gate joins the merge queue and refuses an explicit skip. merge_group events are handled end to end: readEvent understands the queue payload and the gate derives its artifacts from the queued merge's real diff. An explicit [skip coderifts] marker in the PR title, commit message, or environment now fails the run with EXPLICIT_SKIP_NOT_ALLOWED before any API key is spent — until now the marker was read by nothing and such a PR passed green. Outcomes carry their own namespace: NO_CONTRACT_CHANGE and its peers are outcomes, not denial reasons, and a run that finds no contract change concludes success by saying so rather than staying silent.


## 0.9.5

The vendored verification core is re-pinned to the signed receipt-verifier v1.0.2. vendor-core verifies every core file against `git show v1.0.2` and checks the signed tag against the recorded fingerprint; VENDOR.sha256 records the digests the check compares against. No behaviour change in the gate itself — this moves the core the gate verifies with, not what it decides.


## 0.9.4

The check output cites the grant_id and receipt-digest with a travelling scope claim. The grant_id (from the verified payload) and the receipt-digest appear in the human summary and a fenced coderifts-citation block, so a foreign CI showing the check can reference the decision. The does_not_prove claim travels with the token: the digest does not mean the merge happened, CI passed, or any third party witnessed it.


## 0.9.3

The vendored verification core is re-pinned to the signed receipt-verifier v1.0.1 (byte-identical to v1.0.0; the provenance names the signed tag and the signer). vendor-core verifies every core file against git show v1.0.1 and verifies the signed tag against the recorded fingerprint.


## 0.9.2

The vendored verification core is re-pinned to receipt-verifier v1.0.0 (51a8224) and re-vendored to match the released tag. verify-grant.js now admits a grant carrying the reserved inert v2 fields (call_hash, executor_image_digest) instead of returning MALFORMED; the verify.js delta is comment-only CLI docs. vendor-core compares the bytes against git show v1.0.0:<file>, adding an upstream comparison it did not have before.


## 0.8.0

### Added

- **`check-name` input.** The name of the Check Run this Action posts is now configurable
  (default `CodeRifts / contract-gate`, unchanged). Set it only when another integration
  already posts under that name — the CodeRifts GitHub App posts the same name, so a
  repository running both would otherwise show two identically-named checks and branch
  protection could not tell them apart. A changed name must also be the required-check
  context in branch protection; see ENFORCEMENT.md.
- **The decision's own next step on a non-allow decision.** When the receipt verifies and the
  decision is not allow-class (`decision_not_allow`), the check output now renders
  `control_envelope.next_agent_step` — `action`, `reason`, `resume_condition`, `then_call` —
  verbatim from the server, under the heading "Next step (from the decision)", followed by a
  fixed line stating that it is a suggestion and that `execution_action` remains the field to
  branch on. Absent or malformed → no heading is rendered; no step is invented.

  This is deliberately **not** a `deny-remedy.v1` block. That schema describes a grant that is
  missing, invalid, or scoped elsewhere, and its `action_required` says to call
  `preflight_change_set` in authorize mode. A policy BLOCK is none of those — the caller held a
  verified receipt and the decision was no — so telling them to request a grant would send them
  back for the same answer.

### Unchanged

- The default check name is byte-for-byte the documented required-check context; a test asserts
  it against the string ENFORCEMENT.md instructs operators to configure.
- Verdicts. Rendering a next step does not change any conclusion: a failure stays a failure, and
  every verdict field on a run carrying a step matches a run without one.
- The vendored verify core (`src/verify.js` `b1d87994…`, `src/arity.js`) and the deny-remedy
  builder are untouched.

## 0.7.0

Source: the GitHub release notes for `v0.7.0`, plus the commits in `v0.6.0..v0.7.0`.

### Security

- **Receipts signed by a revoked key verified as current.** Versions 0.2.1 through 0.6.0 vendored a
  verify core that read key status only for `retired`. With a pinned keyring, a receipt signed by a
  key the registry marked `revoked` — or carrying `revoked_at`, or an unknown status — still
  verified as current, so the gate could pass a merge on a withdrawn key. 0.7.0 vendors the current
  receipt-verifier core (sha256 `b1d87994…`) and pins it by digest and by revocation/retirement test
  vectors. Consumers on `@v0` received this when the tag moved. (`f3e924d`)

### Added

- A DSSE/in-toto envelope is accepted as receipt input; verification is unchanged — the envelope is
  unwrapped to the compact token and the same checks decide. (`3c56e8c`, advertised in `db2ec4b`)
- A machine-readable remedy (`deny-remedy.v1`) in the check-run output and PR comment on failure;
  the conclusion is unchanged. (`cf78745`)

## 0.6.0

No GitHub release notes exist for this tag. The entries below are the changes named by the commits
in `v0.5.0..v0.6.0`.

### Changes (from commit history)

- Verify `cr.exec.v2` grants; fetch a per-PR grant from a signed PR comment bound to `head_sha`.
  (`551328c`)
- Ship `LICENSE` in `files[]`. (`1ebe3f8`)
- Documentation: residual #2 previously named the defect and stopped. It now states that
  issuer-pinning does not fix it and why — `github-actions[bot]` is shared by every workflow — that
  the App already posts this same check name and derives its verdict server-side, that what the App
  cannot do is conclude failure under the phase-1 clamp, and that forwarding a CI verdict would move
  the attribution without moving the trust. (`ff4198c`)

## 0.5.0

No GitHub release notes exist for this tag. The entries below are the changes named by the commits
in `v0.4.0..v0.5.0`.

### Changes (from commit history)

- `require-grant` now verifies the token and derives the governed set. The previous round accepted a
  `grant_result` on trust while ENFORCEMENT.md described "a valid grant"; the token is now parsed as
  `cr.exec.v1`, its kid resolved against the pinned keyring with no network fetch, its Ed25519
  signature checked, and its `exp`/`iat` evaluated with the shipped leeway — by calling `verify.js`'s
  `resolveEntry` / `isExpiredAt` / `loadKeyring` rather than adding a second crypto path.
  `deriveStatus` is deliberately not called: it returns `RETIRED_KEY_VALID_AT_ISSUE` as a passing
  class, and for grants a retired kid is never live permission. The governed set is derived from the
  diff via the single classifier, and unreadable entries are carried rather than dropped. Two
  defects were found using real tokens, including a status map keyed on a `GRANT_MALFORMED` value the
  kernel never emits. 88 → 105 tests. (`c63e429`)
- `require-grant` introduced as the store-side gate, default `false`. Recomputes the after-content
  hash from the diff and matches it against the supplied grant, with the hasher mirrored from the app
  and tests asserting byte-identity against the app's implementation. Six distinct failure classes,
  with `path_unreadable` as an undecidable that outranks a valid grant. Three residuals are stated in
  code and in ENFORCEMENT.md: pre-receive hooks are unreachable on github.com; the check does not
  carry App identity (`github-token` defaults to `github.token`, so runs are attributed to
  `github-actions[bot]`); and the gate evaluates merges rather than pushes. 68 → 88 tests. (`b76ea41`)
- Documentation: the tagline said this Action "blocks a merge" and that "an in-process agent cannot
  bypass" it, both unconditional. It now states the condition — marked required in branch protection,
  the failing check blocks; on its own it posts a Check Run and nothing more — and the residual, that
  an admin with `enforce_admins: false` can still merge past it. SECURITY.md gains the
  artifact-is-not-the-contract boundary. (`5a1195f`)

## 0.4.0

### Added

- **B2/1b: consume `cr.monitor.attest.v1` offline.** New inputs
  `monitoring-attestation` (token string) and `monitoring-keyring` (local JSON
  file, same shape as the receipt keyring). When
  `require-verified-monitoring: true` and `execution_action` is
  `CONTINUE_WITH_MONITORING`, the gate verifies the token with `node:crypto`
  Ed25519 (same path as receipt verification). PASS only if status is
  `MON_ATTEST_VALID` or `MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE` **and**
  `delivery_status === delivered_acked`. Cross-check uses the gate's own
  preflight envelope: `decision_id` from `decision_result`, `receipt_digest =
  sha256:` + SHA-256 UTF-8 of the `chain_receipt` token (byte-exact with
  guard `receiptDigestOfToken`). No network fetch, ever.

### Breaking under the flag (tightening)

- Unsigned `monitoring-delivery` JSON is **no longer accepted** when
  `require-verified-monitoring` is true. Missing token → BLOCK
  `monitoring_attestation_missing`. Do not silently fall back to JSON.
- Default flag remains **false** — existing consumers are byte-identical.

### Honest label

With the flag true and a token, the gate **verifies** delivery evidence
offline. Remaining limit: the token proves a monitoring-key holder observed
the delivery — not that a human read it, not that the sink targets the right
audience.

## 0.3.0

### Added

- **P0-4 (audit): `require_verified_monitoring` (default `false`).** When true, a
  `CONTINUE_WITH_MONITORING` decision passes **only** if the inputs carry
  `monitoring_delivery.status === "delivered_acked"`. `sent_unacked`,
  `not_delivered`, or missing evidence → **BLOCK** with reason
  `monitoring_not_verified` (WHY line names what to provide). `CONTINUE` is
  unaffected in both modes.
- Action inputs: `require-verified-monitoring` (default `false`) and optional
  `monitoring-delivery` (JSON). Existing consumers are unchanged.

### Honesty / evidence reachability

The gate today reads: git-derived artifacts, `POST /api/v1/preflight` →
`chain_receipt` + `decision_result`, the pinned keyring, and PR identity
(head/base/repo/operation). It does **not** see a GuardOutcome, and the
receipt/crbundle does **not** carry `monitoring_delivery`. There is no signed
monitoring-delivery attestation in the artifact chain that the pinned keyring
could verify.

The optional `monitoring-delivery` input is therefore how evidence becomes
reachable: it is the guard ≥8.4.0 observation JSON the workflow supplies, **not**
a keyring-verified token. Do not read a pass under this flag as "the sink was
cryptographically proven." The missing next tétel is a signed
monitoring-delivery attestation (or a guard-outcome envelope) that this gate
can verify offline with the pinned keyring.

**Default stays false.** Flipping it is a later, evidence-gated decision.

The five honest-label sites now say: *with require_verified_monitoring: true the
gate blocks CWM without delivery evidence; by default it passes CWM on the
host's claim.*
