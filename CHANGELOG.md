# Changelog

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
