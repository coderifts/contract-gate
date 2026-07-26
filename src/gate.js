'use strict';

/**
 * The gate decision — PURE (no I/O), so it is fully unit-testable and the verify.js crypto path is
 * exercised for real. Fail-closed on every branch: the ONLY way to pass is a receipt that verifies
 * offline against the pinned keyring AND a decision whose execution_action is an approval
 * (CONTINUE / CONTINUE_WITH_MONITORING). Semantics = "signed ALLOW for this exact change set",
 * never "breaking == 0".
 */

const { verifyReceipt } = require('./verify');

// Execution actions that permit a merge. STOP (BLOCK) and REQUEST_APPROVAL (REQUIRE_APPROVAL) do not.
const PASSING_ACTIONS = new Set(['CONTINUE', 'CONTINUE_WITH_MONITORING']);

/**
 * @param {object} o
 * @param {object} o.preflightResponse  parsed POST /api/v1/preflight body
 * @param {Map} o.keyring               pinned keyring (kid -> { publicKey, status, retired_at })
 * @param {string} [o.headSha]          the commit this decision is bound to (for the check output)
 * @param {number} [o.now]              clock override (tests)
 * @returns {{ pass:boolean, conclusion:'success'|'failure', reason:string,
 *             decision:(string|null), executionAction:(string|null), receiptStatus:(string|null),
 *             headSha:(string|null), summary:string }}
 */
function evaluateGate({ preflightResponse, keyring, headSha = null, now }) {
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
  // THIS decision_result, which was built from the diff-derived artifacts.
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

  return {
    pass: true, conclusion: 'success', reason: 'signed_allow_for_diff',
    decision, executionAction, receiptStatus: result.status, headSha,
    summary: buildSummary({ pass: true, reason: 'signed_allow_for_diff', decision, executionAction, receiptStatus: result.status, headSha }),
  };
}

function buildSummary({ pass, reason, decision, executionAction, receiptStatus, headSha }) {
  const lines = [
    pass ? '✅ **CodeRifts contract-gate: PASS**' : '❌ **CodeRifts contract-gate: FAIL** (merge blocked)',
    '',
    `- reason: \`${reason}\``,
    `- decision: \`${decision ?? 'n/a'}\` (execution_action: \`${executionAction ?? 'n/a'}\`)`,
    `- receipt status: \`${receiptStatus ?? 'n/a'}\``,
    `- head commit: \`${headSha ?? 'n/a'}\``,
    '',
    pass
      ? 'A valid signed ALLOW receipt was verified **offline against the pinned keyring** for the exact head diff.'
      : 'No valid signed ALLOW receipt exists for this exact head diff. Verified offline against the pinned keyring; fail-closed.',
  ];
  return lines.join('\n');
}

module.exports = { evaluateGate, PASSING_ACTIONS, buildSummary };
