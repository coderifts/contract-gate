'use strict';

/**
 * The gate decision — PURE (no I/O), so it is fully unit-testable and the verify.js crypto path is
 * exercised for real. Fail-closed on every branch: the ONLY way to pass is a receipt that verifies
 * offline against the pinned keyring AND a decision whose execution_action is an approval
 * (CONTINUE / CONTINUE_WITH_MONITORING) AND whose signed envelope slots match expectedContext
 * (current PR identity). Semantics = "signed ALLOW for this exact change set AND this exact
 * head/base/repo/operation", never "breaking == 0".
 *
 * CWM honesty: with require_verified_monitoring: true the gate blocks CWM without delivery
 * evidence; by default it passes CWM on the host's claim. The guard side records measured
 * delivery evidence (monitoring_delivery tri-state, guard >=8.4.0). That observation is not
 * in the receipt/crbundle — pass it as monitoring_delivery when requiring verification.
 */

const { verifyReceipt } = require('./verify');

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
 * @param {boolean} [o.require_verified_monitoring=false]  when true, CWM passes only with
 *   monitoring_delivery.status === 'delivered_acked'. Default false — existing consumers unchanged.
 * @param {object} [o.monitoring_delivery]  reachable delivery evidence (guard observation JSON).
 *   Not present on the receipt/crbundle; the gate cannot mint or keyring-verify a signed
 *   monitoring-delivery attestation (that artifact does not exist yet).
 * @param {number} [o.now]              clock override (tests)
 * @returns {{ pass:boolean, conclusion:'success'|'failure', reason:string,
 *             decision:(string|null), executionAction:(string|null), receiptStatus:(string|null),
 *             headSha:(string|null), summary:string }}
 */
function evaluateGate({
  preflightResponse, keyring, headSha = null, expectedContext = null, now,
  require_verified_monitoring = false,
  monitoring_delivery = null,
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
    const status = monitoring_delivery && typeof monitoring_delivery === 'object'
      ? monitoring_delivery.status
      : null;
    if (status !== 'delivered_acked') {
      const what = status
        ? `monitoring_delivery.status is ${status} (need delivered_acked)`
        : 'no delivery evidence was supplied';
      return fail('monitoring_not_verified', {
        receiptStatus: result.status, decision, executionAction,
        why: `${what}. Provide monitoring_delivery.status === "delivered_acked" (guard ≥8.4.0 observation). The receipt/crbundle does not carry a signed monitoring-delivery attestation.`,
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
