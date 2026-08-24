'use strict';

/**
 * The gate decision — PURE (no I/O), so it is fully unit-testable and the verify.js crypto path is
 * exercised for real. Fail-closed on every branch: the ONLY way to pass is a receipt that verifies
 * offline against the pinned keyring AND a decision whose execution_action is an approval
 * (CONTINUE / CONTINUE_WITH_MONITORING) AND whose signed envelope slots match expectedContext
 * (current PR identity). Semantics = "signed ALLOW for this exact change set AND this exact
 * head/base/repo/operation", never "breaking == 0".
 *
 * CWM honesty: with require_verified_monitoring: true the gate verifies a cr.monitor.attest.v1
 * token offline against a pinned monitoring keyring (CWM passes only on delivered_acked);
 * by default it passes CWM on the host's claim. The token proves a monitoring-key holder
 * observed the delivery — not that a human read it, not that the sink targets the right audience.
 */

const { verifyReceipt } = require('./verify');
const {
  verifyMonitoringAttestation,
  receiptDigest,
  STATUSES: MON_STATUSES,
} = require('./monitoring-attestation');

// Execution actions that permit a merge. STOP (BLOCK) and REQUEST_APPROVAL (REQUIRE_APPROVAL) do not.
const PASSING_ACTIONS = new Set(['CONTINUE', 'CONTINUE_WITH_MONITORING']);

/**
 * Non-empty string slot. null/undefined/'' are unbound — not a match (P0-1: missing is not believed).
 * @param {*} v
 * @returns {string|null}
 */
function boundSlot(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Compare a signed envelope slot to the current expected value.
 * Missing on either side OR mismatch → fail (never treat unbound as "matches anything").
 * @returns {string|null} reason token, or null when the slot matches
 */
function mismatchReason(envelope, expected, envelopeKey, expectedKey, reason) {
  const got = boundSlot(envelope[envelopeKey]);
  const want = boundSlot(expected && expected[expectedKey]);
  if (got == null || want == null || got !== want) return reason;
  return null;
}

/**
 * @param {object} o
 * @param {object} o.preflightResponse  parsed POST /api/v1/preflight body
 * @param {Map} o.keyring               pinned keyring (kid -> { publicKey, status, retired_at })
 * @param {string} [o.headSha]          current PR head SHA (check output; same as expectedContext.head)
 * @param {object} [o.expectedContext]  current PR identity from runGate: { operation, repository, base, head }
 * @param {boolean} [o.require_verified_monitoring=false]  when true, CWM requires a
 *   cr.monitor.attest.v1 token verified offline. Default false — existing consumers unchanged.
 *   Unsigned JSON is NOT accepted under the flag (no silent fallback).
 * @param {string} [o.monitoring_attestation]  cr.monitor.attest.v1 token string
 * @param {object} [o.monitoring_keyring]  { keys: [...] } local registry document
 * @param {number} [o.now]              clock override (tests)
 * @returns {{ pass:boolean, conclusion:'success'|'failure', reason:string,
 *             decision:(string|null), executionAction:(string|null), receiptStatus:(string|null),
 *             headSha:(string|null), summary:string }}
 */
function evaluateGate({
  preflightResponse, keyring, headSha = null, expectedContext = null, now,
  require_verified_monitoring = false,
  monitoring_attestation = null,
  monitoring_keyring = null,
}) {
  const fail = (reason, extra = {}) => ({
    pass: false, conclusion: 'failure', reason,
    decision: extra.decision ?? null, executionAction: extra.executionAction ?? null,
    receiptStatus: extra.receiptStatus ?? null, headSha,
    summary: buildSummary({ pass: false, reason, headSha, ...extra }),
  });

  if (!preflightResponse || typeof preflightResponse !== 'object') return fail('no_preflight_response');

  const token = preflightResponse.chain_receipt;
  const envelope = preflightResponse.decision_result;
  if (typeof token !== 'string' || token.length === 0) return fail('missing_receipt');
  if (!envelope || typeof envelope !== 'object') return fail('missing_decision_result');

  // Verify OFFLINE against the pinned keyring. expectedKid:null => accept any kid present in the
  // pinned bundle (rotation is additive); an unpinned kid resolves to UNKNOWN_KEY => fail-closed.
  // Passing the envelope activates verify.js step 6 (v4 body_hash binding): the receipt is bound to
  // THIS decision_result (complete envelope, including head/base/repo/operation/preflight_mode).
  let result;
  try {
    result = verifyReceipt(token, { keyring, expectedKid: null }, { envelope, now });
  } catch (err) {
    return fail('verify_threw', { receiptStatus: `error:${err && err.message ? err.message : 'unknown'}` });
  }

  const executionAction = typeof envelope.execution_action === 'string' ? envelope.execution_action : null;
  const decision = typeof envelope.decision === 'string' ? envelope.decision : null;

  if (!result || result.valid !== true) {
    return fail('receipt_unverified', { receiptStatus: result ? result.status : null, decision, executionAction });
  }
  if (!executionAction || !PASSING_ACTIONS.has(executionAction)) {
    return fail('decision_not_allow', { receiptStatus: result.status, decision, executionAction });
  }
  if (require_verified_monitoring === true && executionAction === 'CONTINUE_WITH_MONITORING') {
    const tokenStr = typeof monitoring_attestation === 'string' ? monitoring_attestation.trim() : '';
    if (!tokenStr) {
      return fail('monitoring_attestation_missing', {
        receiptStatus: result.status, decision, executionAction,
        why: 'require_verified_monitoring is true and execution_action is CONTINUE_WITH_MONITORING but no monitoring-attestation token was supplied. Unsigned JSON is not accepted.',
      });
    }
    if (!monitoring_keyring || typeof monitoring_keyring !== 'object') {
      return fail('monitoring_keyring_missing', {
        receiptStatus: result.status, decision, executionAction,
        why: 'monitoring-attestation was supplied but no local monitoring-keyring document was provided (no network fetch).',
      });
    }
    const decisionId = typeof envelope.decision_id === 'string' ? envelope.decision_id : '';
    const intendedDigest = receiptDigest(token);
    const mon = verifyMonitoringAttestation(tokenStr, {
      registry: monitoring_keyring,
      intended: { decision_id: decisionId, receipt_digest: intendedDigest },
      now,
    });
    const okStatus = mon.status === MON_STATUSES.MON_ATTEST_VALID
      || mon.status === MON_STATUSES.MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE;
    if (!okStatus) {
      const reasonByStatus = {
        [MON_STATUSES.MON_ATTEST_INVALID_SIGNATURE]: 'monitoring_attest_invalid_signature',
        [MON_STATUSES.MON_ATTEST_UNKNOWN_KEY]: 'monitoring_attest_unknown_key',
        [MON_STATUSES.MON_ATTEST_MALFORMED]: 'monitoring_attest_malformed',
        [MON_STATUSES.MON_ATTEST_UNBOUND]: 'monitoring_attest_unbound',
      };
      const reason = reasonByStatus[mon.status] || 'monitoring_not_verified';
      return fail(reason, {
        receiptStatus: result.status, decision, executionAction,
        why: `monitoring attestation failed: status ${mon.status}`
          + (mon.reason ? ` (${mon.reason})` : '')
          + '. Need MON_ATTEST_VALID or MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE, cross-checked against this envelope decision_id and sha256(chain_receipt).',
      });
    }
    const deliveryStatus = mon.payload && mon.payload.delivery_status;
    if (deliveryStatus !== 'delivered_acked') {
      return fail('monitoring_not_verified', {
        receiptStatus: result.status, decision, executionAction,
        why: `monitoring attestation verified (${mon.status}) but delivery_status is ${deliveryStatus || 'missing'} (need delivered_acked).`,
      });
    }
  }

  // P0-1: rebind the signed envelope to the CURRENT PR identity. Missing expectedContext or any
  // unbound/mismatched slot is not permission. Envelope slots are ID686 top-level fields covered
  // by decision_body_hash (verify.js step 6 already checked bh === canonical(envelope)).
  const ctx = expectedContext && typeof expectedContext === 'object' ? expectedContext : {};
  const mode = boundSlot(envelope.preflight_mode);
  if (mode !== 'authorize') {
    return fail('mode_mismatch', { receiptStatus: result.status, decision, executionAction });
  }
  const bindFail =
    mismatchReason(envelope, ctx, 'operation', 'operation', 'operation_mismatch')
    || mismatchReason(envelope, ctx, 'repository', 'repository', 'repo_mismatch')
    || mismatchReason(envelope, ctx, 'base', 'base', 'base_mismatch')
    || mismatchReason(envelope, ctx, 'head', 'head', 'head_mismatch');
  if (bindFail) {
    return fail(bindFail, { receiptStatus: result.status, decision, executionAction });
  }

  return {
    pass: true, conclusion: 'success', reason: 'signed_allow_for_diff',
    decision, executionAction, receiptStatus: result.status, headSha,
    summary: buildSummary({ pass: true, reason: 'signed_allow_for_diff', decision, executionAction, receiptStatus: result.status, headSha }),
  };
}

function buildSummary({ pass, reason, decision, executionAction, receiptStatus, headSha, why }) {
  const lines = [
    pass ? '✅ **CodeRifts contract-gate: PASS**' : '❌ **CodeRifts contract-gate: FAIL** (merge blocked)',
    '',
    `- reason: \`${reason}\``,
    `- decision: \`${decision ?? 'n/a'}\` (execution_action: \`${executionAction ?? 'n/a'}\`)`,
    `- receipt status: \`${receiptStatus ?? 'n/a'}\``,
    `- head commit: \`${headSha ?? 'n/a'}\``,
    ...(why ? ['', `- why: ${why}`] : []),
    '',
    pass
      ? 'A valid signed ALLOW receipt was verified **offline against the pinned keyring** for the exact head diff.'
      : 'No valid signed ALLOW receipt exists for this exact head diff. Verified offline against the pinned keyring; fail-closed.',
  ];
  return lines.join('\n');
}

module.exports = { evaluateGate, PASSING_ACTIONS, buildSummary };
