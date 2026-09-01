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
const { unwrapReceiptInput } = require('./from-dsse.js');
const {
  verifyMonitoringAttestation,
  receiptDigest,
  STATUSES: MON_STATUSES,
} = require('./monitoring-attestation');
const { evaluateGrantCoverage } = require('./grant-coverage.js');
const { buildDenyRemedy, denyErrorForReason } = require('./deny-remedy.js');

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
  require_grant = false,
  grant_result = null,
  governed_artifacts = null,
  grant_operation = 'merge',
  repository = null,
}) {
  // The refusal, plus the next step when this reason maps to one of the three
  // classes the schema defines. A reason outside that map (verify_threw,
  // monitoring_*, path_unreadable) gets NO remedy: an unactionable refusal is
  // reported as unactionable rather than given a plausible-looking instruction.
  //
  // Attached AFTER the verdict. `pass`, `conclusion` and `reason` are what they
  // were before this existed; the remedy is additive.
  const fail = (reason, extra = {}) => {
    const remedy = buildDenyRemedy({
      error: denyErrorForReason(reason),
      // This gate's own addressing is the repository it governs. The head SHA is
      // a git commit id, NOT a sha256 content fingerprint, so it rides in
      // `observed` and `fingerprint` stays null rather than carrying a value of
      // the wrong kind.
      target: typeof repository === 'string' && repository.length > 0 ? repository : null,
      observed: {
        reason,
        ...(extra.receiptStatus ? { receipt_status: extra.receiptStatus } : {}),
        ...(headSha ? { head_sha: headSha } : {}),
      },
    });
    return {
      pass: false, conclusion: 'failure', reason,
      decision: extra.decision ?? null, executionAction: extra.executionAction ?? null,
      receiptStatus: extra.receiptStatus ?? null, headSha,
      ...(remedy ? { remedy } : {}),
      ...(extra.nextStep ? { nextStep: extra.nextStep } : {}),
      summary: buildSummary({ pass: false, reason, headSha, ...extra, remedy }),
    };
  };

  if (!preflightResponse || typeof preflightResponse !== 'object') return fail('no_preflight_response');

  // ── RECEIPT INPUT: compact token OR DSSE envelope (roadmap 1224 Phase 3a) ───
  //
  // `chain_receipt` may now arrive as a DSSE / in-toto envelope, so an external
  // system that emits the standard export passes this gate. UNPACKING ONLY:
  // fromDSSE returns the compact token byte-for-byte, and verifyReceipt below
  // decides with the same nine checks it has always run.
  //
  // A DSSE envelope is NOT evidence. One wrapping a receipt with a bad
  // signature unpacks cleanly and then fails verification, exactly as that
  // compact token would have — the signature is over the compact bytes
  // (RECEIPT_FORMAT.md §9). Nothing below this line changed.
  const unwrapped = unwrapReceiptInput(preflightResponse.chain_receipt);
  if (!unwrapped.ok) {
    return fail(unwrapped.reason, unwrapped.detail ? { receiptStatus: unwrapped.detail } : {});
  }
  const token = unwrapped.token;
  const envelope = preflightResponse.decision_result;
  if (typeof token !== 'string' || token.length === 0) return fail('missing_receipt');
  if (!envelope || typeof envelope !== 'object') return fail('missing_decision_result');

  // Verify OFFLINE against the pinned keyring. expectedKid:null => accept any kid present in the
  // pinned bundle (rotation is additive); an unpinned kid resolves to UNKNOWN_KEY => fail-closed.
  // Passing the envelope activates verify.js step 6 (v4 body_hash binding): the receipt is bound to
  // THIS decision_result (complete envelope, including head/base/repo/operation/preflight_mode).
  let result;
  try {
    result = verifyReceipt(token, { ctx: { keyring, expectedKid: null }, envelope, now });
  } catch (err) {
    return fail('verify_threw', { receiptStatus: `error:${err && err.message ? err.message : 'unknown'}` });
  }

  const executionAction = typeof envelope.execution_action === 'string' ? envelope.execution_action : null;
  const decision = typeof envelope.decision === 'string' ? envelope.decision : null;

  if (!result || result.valid !== true) {
    return fail('receipt_unverified', { receiptStatus: result ? result.status : null, decision, executionAction });
  }
  if (!executionAction || !PASSING_ACTIONS.has(executionAction)) {
    // A policy refusal is NOT a missing grant, so it carries no deny-remedy block. What it can
    // carry is the decision's OWN remediation suggestion, which the server already computed.
    return fail('decision_not_allow', {
      receiptStatus: result.status, decision, executionAction,
      nextStep: readNextAgentStep(preflightResponse),
    });
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

  // ── require-grant (roadmap 1010 / panel C1) ───────────────────────────────────────────────
  // Store-side coverage: the claim is about the CHANGE SET reaching a protected path, never about
  // the agent. Default false, so every existing consumer is byte-identical.
  //
  // RESIDUALS — true with this flag on, and not fixable from inside this Action:
  //   1. A repository admin with `enforce_admins: false` still lands the change. The record of
  //      that lands in GitHub's own audit log, signed by a party we do not control.
  //   2. This check is posted with the workflow's GITHUB_TOKEN, so it carries
  //      github-actions[bot] identity, NOT the CodeRifts App id. An agent that can edit
  //      .github/workflows/ can change what runs and still post a green check under this name.
  //      Govern those paths too, or the gate is advisory against that actor.
  //   3. Behaviour can change without touching the artifact: a grant binds contract bytes, not
  //      runtime behaviour. A change that keeps every governed file byte-identical passes here
  //      and can still change what the service does.
  if (require_grant === true) {
    const cov = evaluateGrantCoverage({
      governedArtifacts: governed_artifacts || [],
      grantResult: grant_result,
      operation: grant_operation,
      repository,
    });
    if (!cov.covered) {
      return fail(cov.reason, {
        receiptStatus: result.status, decision, executionAction,
        why: cov.why,
      });
    }
  }

  return {
    pass: true, conclusion: 'success', reason: 'signed_allow_for_diff',
    decision, executionAction, receiptStatus: result.status, headSha,
    summary: buildSummary({ pass: true, reason: 'signed_allow_for_diff', decision, executionAction, receiptStatus: result.status, headSha }),
  };
}

/**
 * `control_envelope.next_agent_step` off the preflight response this gate already parses.
 *
 * MEASURED shape (producer: response-envelope.js `projectNextAgentStep`) —
 * `{ action, reason, resume_condition, then_call }`, where `action` is one of
 * re_preflight | revert | migrate | escalate | await_approval and `then_call` may be null.
 * It is `null` on the allow class, and the producer never invents one for an unknown
 * execution_action.
 *
 * Read defensively and returned verbatim: this gate reports what the decision said, and a
 * response without the field renders no section rather than a guessed step.
 */
function readNextAgentStep(preflightResponse) {
  const env = preflightResponse && typeof preflightResponse === 'object'
    ? preflightResponse.control_envelope
    : null;
  const step = env && typeof env === 'object' ? env.next_agent_step : null;
  if (!step || typeof step !== 'object') return null;
  if (typeof step.action !== 'string' || step.action.length === 0) return null;
  return step;
}

/**
 * The decision's own remediation, rendered as text.
 *
 * DELIBERATELY NOT a deny-remedy.v1 block. That schema describes a grant that is missing,
 * invalid, or scoped elsewhere, and its `action_required` says "call preflight_change_set in
 * authorize mode". A policy BLOCK is none of those: the caller HELD a verified receipt and the
 * decision was no. Telling them to request a grant would send them back for the same answer.
 *
 * The closing line is fixed and is not from the server: the step is a suggestion, and
 * execution_action remains the thing to branch on.
 */
function nextStepBlock(step) {
  if (!step) return null;
  const field = (label, value) => (value == null || value === ''
    ? null
    : `- ${label}: \`${String(value)}\``);
  return [
    '### Next step (from the decision)',
    '',
    field('action', step.action),
    field('reason', step.reason),
    field('resume_condition', step.resume_condition),
    field('then_call', step.then_call),
    '',
    'This is the decision\'s remediation suggestion, not permission; branch on execution_action.',
  ].filter((l) => l !== null).join('\n');
}

/**
 * The remedy as a fenced JSON block — one renderer, so the check-run summary and
 * the check-run text carry byte-identical bytes for a consumer to parse.
 */
function remedyBlock(remedy) {
  if (!remedy) return null;
  return ['```json', JSON.stringify(remedy, null, 2), '```'].join('\n');
}

function buildSummary({ pass, reason, decision, executionAction, receiptStatus, headSha, why, remedy, nextStep }) {
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
    ...(remedy ? ['', 'To obtain a grant for this change set:', '', remedyBlock(remedy)] : []),
    ...(nextStep ? ['', nextStepBlock(nextStep)] : []),
  ];
  return lines.join('\n');
}

module.exports = { evaluateGate, PASSING_ACTIONS, buildSummary, remedyBlock, nextStepBlock, readNextAgentStep };
