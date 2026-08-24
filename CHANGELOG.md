# Changelog

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
