'use strict';
/**
 * crbundle.v1 acceptance for the merge gate (1261).
 *
 * ── THIS FILE GRADES NOTHING ITSELF ─────────────────────────────────────────────────────────
 *
 * Every slot verdict comes from the VENDORED `src/verify-bundle.js`, byte-identical to
 * receipt-verifier and pinned in `src/VENDOR.sha256`. Re-implementing the grading here would give
 * the gate a second opinion about what a bundle proves, and the whole value of a bundle is that
 * one library decides. What this file does is decide which slots THIS gate's operation needs, and
 * how to report the rest.
 *
 * ── THE TRAP THIS FILE EXISTS TO AVOID, MEASURED ────────────────────────────────────────────
 *
 * `SLOT.VERIFIED` does not mean "cryptographically proven". verify-bundle.js:313 sets a slot to
 * VERIFIED whenever its verifier returned `valid: true` — and `verifyProviderReadback`
 * (verify-bundle.js:129-133) returns exactly that for an UNSIGNED provider readback, with
 * `status: 'PROVIDER_READBACK'` and a `does_not_prove` line saying so. So a bundle whose
 * merge_evidence slot is a self-asserted JSON blob comes back VERIFIED.
 *
 * A gate that read `state === 'VERIFIED'` and stopped would therefore accept an unsigned claim as
 * proof. The class is carried in `status`, not in `state`, and this module keys on `status`.
 *
 * ── "MODELLED" IS NOT A CLASS HERE, AND IS NOT INVENTED ─────────────────────────────────────
 *
 * MEASURED 2026-09-02: `MODELLED` appears nowhere in receipt-verifier. It is the vocabulary of the
 * deploy-attestation end-to-end run, not of cr.bundle.v1. The classes a bundle actually returns
 * are the slot `status` values, so those are what this gate names. Reporting a class the library
 * does not produce would be a label with nothing behind it.
 */

const { verifyBundle, SLOT, BUNDLE } = require('./verify-bundle.js');

/**
 * Slot statuses that constitute CRYPTOGRAPHIC proof — a signature checked against a pinned key.
 * Deliberately an allow-list: a status this gate has not considered is not proof, and a new
 * status added upstream must be classified here on purpose rather than inherited silently.
 */
// MEASURED 2026-09-02 from the vendored verifiers, not guessed. A first draft of this list used
// plausible names (`GRANT_VALID`, `TOOLSET_VALID`) and every real bundle graded UNCLASSIFIED —
// which is the allow-list doing its job: an unrecognised status is refused, never waved through.
// The names below are the ones the five verifiers actually return alongside `valid: true`.
const PROVEN_STATUSES = Object.freeze([
  'VERIFIED_CURRENT',                          // verify.js:289
  'RETIRED_KEY_VALID_AT_ISSUE',                // verify.js:289 — signed while the key was live
  'GRANT_CURRENT',                             // verify-grant.js
  'ATTEST_VALID',                              // verify-attest.js
  'ATTEST_RETIRED_KEY_VALID_AT_ISSUE',
  'TOOLSET_ATTEST_VALID',                      // verify-toolset.js
  'TOOLSET_ATTEST_RETIRED_KEY_VALID_AT_ISSUE',
  'ATOMIC_ATTEST_VALID',                       // verify-atomic-attestation.js
]);

/**
 * Statuses that are honest evidence and are NOT proof. Named in the output so a reader sees the
 * class rather than a bare pass.
 */
const UNPROVEN_ACCEPTED_STATUSES = Object.freeze(['PROVIDER_READBACK']);

/**
 * The slots a MERGE gate's own operation needs proven.
 *
 * WHY THESE TWO AND NOT MORE. The gate authorises a merge, and what a merge decision rests on is
 * the signed decision (receipt) and the permission bound to this change set (execution grant) —
 * the two things this Action already verifies on its non-bundle path (gate.js:139,
 * execution-grant-verify.js:95). Requiring `commit_attestation` or `deploy_attestation` would
 * demand evidence about events that have not happened yet at merge time; requiring
 * `merge_evidence` as PROOF would be requiring a class that cannot be proven, since it is unsigned
 * by construction.
 */
const REQUIRED_PROVEN_SLOTS = Object.freeze(['receipt', 'execution_grant']);

/** Slots this gate reports when present but never requires and never counts as proof. */
const REPORTED_SLOTS = Object.freeze(['merge_evidence', 'commit_attestation', 'deploy_attestation']);

function classOf(slot) {
  if (!slot || slot.state === SLOT.ABSENT) return 'ABSENT';
  const status = typeof slot.status === 'string' ? slot.status : null;
  if (slot.state === SLOT.VERIFIED && status && PROVEN_STATUSES.includes(status)) return 'PROVEN';
  if (slot.state === SLOT.VERIFIED && status && UNPROVEN_ACCEPTED_STATUSES.includes(status)) return status;
  if (slot.state === SLOT.VERIFIED) {
    // VERIFIED under a status this gate does not classify. Not proof — see the allow-list note.
    return 'UNCLASSIFIED';
  }
  return 'INVALID';
}

/**
 * Grade a bundle for a merge.
 *
 * @param {object} bundle  a parsed cr.bundle.v1 document
 * @param {object} opts    forwarded UNCHANGED to verifyBundle — this module handles no key
 *                         material of its own, exactly as the library requires
 * @returns {{
 *   ok: boolean, reason: (string|null), bundleState: string,
 *   classes: Record<string,string>, proven: string[], reported: string[], summary: string
 * }}
 */
function evaluateBundle(bundle, opts = {}) {
  let graded;
  try {
    graded = verifyBundle(bundle, opts);
  } catch (err) {
    // The library throws on a green-empty result (verify-bundle.js:178). A throw is a refusal to
    // return a verdict, and it is reported as one rather than swallowed into a pass.
    return {
      ok: false,
      reason: 'bundle_verifier_threw',
      bundleState: null,
      linkage: [],
      classes: {},
      proven: [],
      reported: [],
      summary: `bundle verifier refused a verdict: ${String((err && err.message) || 'unknown').slice(0, 160)}`,
    };
  }

  // ── ONE RUN, not merely one valid token each (1441 / 1432) ──────────────────────────────
  //
  // MEASURED before this was added: the vendored library's only cross-slot check is
  // `grant_binds_receipt` — PAIRWISE. A bundle whose receipt AND grant both came from a second run
  // (a matched, genuinely signed pair) satisfies it, and every other slot stays VERIFIED beside
  // them. Authentic tokens, two runs, one merge — the collage class, open in the path the App is
  // supposed to be the verification authority for.
  //
  // IT LIVES HERE, NOT IN verify-bundle.js. That file is a byte copy of receipt-verifier and
  // test/vendor-core.test.js fails the moment it is edited — which is exactly what happened on the
  // first attempt. Grading policy is this Action's job; the library's job is to verify tokens.
  //
  // ABSENT IS REPORTED, NOT REFUSED. Bundles predating cr.evidence.root.v1 stay gradeable; what
  // changes is that "these tokens are one run" is no longer assumed by the absence of a check.
  const rootLink = (() => {
    const given = (bundle && bundle.slots) || {};
    const rootDoc = given.evidence_root && (given.evidence_root.root || given.evidence_root);
    if (!rootDoc || typeof rootDoc !== 'object') {
      return {
        link: 'evidence_root_binds_run',
        ok: true,
        absent: true,
        reason: 'this bundle carries no cr.evidence.root.v1, so nothing binds its tokens to ONE '
          + 'run; each slot is authentic on its own and the set is not shown to be one merge',
      };
    }
    const tokenOf = (slot) => {
      const v = given[slot];
      return v && typeof v === 'object' && v.token !== undefined ? v.token : v;
    };
    try {
      // eslint-disable-next-line global-require
      const { verifyEvidenceRootBinding } = require('./verify-evidence.js');
      const r = verifyEvidenceRootBinding({
        evidence_root: rootDoc,
        run_id: rootDoc.run_id,
        issuance: {
          chain_receipt: tokenOf('receipt'),
          execution_grant: tokenOf('execution_grant'),
        },
        transcript_token: tokenOf('transcript_token') || null,
        correlation: given.correlation || null,
      }, { executorKey: (opts && opts.ctx && opts.ctx.executorKey) || null });
      return r.ok
        ? { link: 'evidence_root_binds_run', ok: true }
        : { link: 'evidence_root_binds_run', ok: false, reason: r.failures[0] || 'the evidence root did not verify' };
    } catch (err) {
      return {
        link: 'evidence_root_binds_run',
        ok: false,
        reason: `the evidence-root verifier could not run: ${(err && err.message) || 'error'}`,
      };
    }
  })();
  graded.linkage = [...(graded.linkage || []), rootLink];
  if (rootLink.ok === false && graded.bundle !== BUNDLE.INVALID) {
    graded = { ...graded, bundle: BUNDLE.INVALID };
  }

  // ── THE AUTHORIZATION VERDICT, QUOTED (1459) ────────────────────────────────────────────
  //
  // The slots above each verify one token and the linkage binds them to one run. What none of them
  // states is the sentence a merge gate actually needs: is this authorized AND committed. The core
  // predicate answers it, and the required-check path now prints the same named states the guard
  // and Prove print — one vocabulary across the surfaces a holder compares.
  //
  // ADDITIVE. It does not change the bundle verdict: `graded.bundle` is still the library's, and
  // this Action still refuses on INVALID or a broken link. What it adds is a reason a reader can
  // act on when the bundle is technically VERIFIED but the intersection is not met.
  const authorization = (() => {
    try {
      const given = (bundle && bundle.slots) || {};
      const tokenOf = (slot) => {
        const v = given[slot];
        return v && typeof v === 'object' && v.token !== undefined ? v.token : v;
      };
      // eslint-disable-next-line global-require
      const { verifiedExecutionBinding } = require('./verified-execution-binding.js');
      // eslint-disable-next-line global-require
      const { verifyExecutionAttestation } = require('./verify-attest.js');
      const ctx = (opts && opts.ctx) || {};
      const b = verifiedExecutionBinding({
        // ── THE RECEIPT ITSELF, so the core verifies it rather than believing this file ──
        //
        // This passed `{ verified: <a boolean derived from our own grading> }`. The core has since
        // stopped taking that on trust: `receipt.verified` with no token and no key source is the
        // fourth caller-boolean this ecosystem has met, and it can no longer reach the global
        // success token.
        //
        // The bundle already carries the receipt — `tokenOf('receipt')` is right there — and the
        // caller's keyring is already being handed to the grant three lines below. Handing both
        // over means the answer rests on a signature rather than on this module's opinion of one.
        receipt: {
          token: tokenOf('receipt') || '',
          publicKey: ctx.publicKey,
          keyring: ctx.keyring,
          expectedKid: ctx.expectedKid ?? null,
        },
        grant: {
          token: tokenOf('execution_grant') || '',
          publicKey: ctx.publicKey,
          keyring: ctx.keyring,
          expectedKid: ctx.expectedKid ?? null,
        },
        attestation: {
          token: tokenOf('commit_attestation') || tokenOf('deploy_attestation') || null,
          registry: ctx.executorRegistry || null,
          verify: typeof verifyExecutionAttestation === 'function' ? verifyExecutionAttestation : undefined,
        },
        committed: true,
        // The gate holds a bundle, not a prove artifact: `one_run_root` is answered by the linkage
        // above and asking the core for it here would report a shortfall about evidence this
        // surface receives in a different shape.
        required: ['issuer_grant', 'executor_attestation'],
      });
      // THE FIELD THIS SURFACE IS ENTITLED TO. It names a CUSTOM authority set (the gate holds a
      // bundle, not a prove artifact, so `one_run_root` is answered by the linkage above), and the
      // core will not answer a narrower question with the widest word. Reading
      // `authorized_and_committed` after that change would have made this permanently false — a
      // gate that refuses everything looks exactly like a gate that works.
      return { state: b.state, ok: b.requirements_satisfied === true, shortfalls: b.shortfalls };
    } catch (err) {
      return { state: 'UNAVAILABLE', ok: false, shortfalls: [(err && err.message) || 'error'] };
    }
  })();

  const bySlot = new Map((graded.slots || []).map((s) => [s.slot, s]));
  const classes = {};
  for (const s of graded.slots || []) classes[s.slot] = classOf(s);

  if (graded.bundle === BUNDLE.INVALID) {
    // MEASURED: the library sets `reason` only for STRUCTURAL rejects (unknown_slot,
    // unsupported_version). When a slot fails to verify the bundle is INVALID with no reason at
    // all (verify-bundle.js:348, `invalid > 0`), so naming the offending slots is this module's
    // job — "INVALID (unspecified)" tells a holder nothing they can act on.
    const badSlots = (graded.slots || [])
      .filter((sl) => sl.state === SLOT.INVALID)
      .map((sl) => `${sl.slot}${sl.status ? ` (${sl.status})` : ''}`);
    const brokenLinks = (graded.linkage || [])
      .filter((l) => l.ok === false)
      .map((l) => `${l.link}: ${l.reason || 'failed'}`);
    const why = graded.reason
      ? graded.reason
      : [
        badSlots.length ? `invalid slots: ${badSlots.join(', ')}` : null,
        brokenLinks.length ? brokenLinks.join('; ') : null,
      ].filter(Boolean).join(' — ') || 'unspecified';
    return {
      ok: false,
      reason: `bundle_invalid:${graded.reason || 'slot_invalid'}`,
      bundleState: graded.bundle,
      // CARRIED ON EVERY PATH. A link the grader computed but does not return is a check the
      // Action cannot show anyone — including on the EMPTY and INVALID paths, which are exactly
      // where a holder asks what was and was not established.
      linkage: graded.linkage || [],
      authorization,
      classes,
      proven: [],
      reported: [],
      summary: `bundle is INVALID — ${why}. One failing slot invalidates the whole bundle, so `
        + 'nothing in it was accepted, including slots that verified on their own.',
    };
  }
  if (graded.bundle === BUNDLE.EMPTY) {
    return {
      ok: false,
      reason: 'bundle_empty',
      bundleState: graded.bundle,
      // CARRIED ON EVERY PATH. A link the grader computed but does not return is a check the
      // Action cannot show anyone — including on the EMPTY and INVALID paths, which are exactly
      // where a holder asks what was and was not established.
      linkage: graded.linkage || [],
      authorization,
      classes,
      proven: [],
      reported: [],
      summary: 'bundle carries no slots. An empty bundle is never green.',
    };
  }

  const missing = REQUIRED_PROVEN_SLOTS.filter((k) => classes[k] !== 'PROVEN');
  const proven = REQUIRED_PROVEN_SLOTS.filter((k) => classes[k] === 'PROVEN');
  const reported = REPORTED_SLOTS
    .filter((k) => bySlot.has(k) && classes[k] !== 'ABSENT')
    .map((k) => `${k}=${classes[k]}`);

  if (missing.length > 0) {
    const detail = missing.map((k) => {
      const s = bySlot.get(k);
      const why = classes[k] === 'ABSENT'
        ? 'absent'
        : `${classes[k]}${s && s.status ? ` (${s.status})` : ''}`;
      return `${k}: ${why}`;
    }).join('; ');
    return {
      ok: false,
      reason: 'bundle_slot_not_proven',
      bundleState: graded.bundle,
      // CARRIED ON EVERY PATH. A link the grader computed but does not return is a check the
      // Action cannot show anyone — including on the EMPTY and INVALID paths, which are exactly
      // where a holder asks what was and was not established.
      linkage: graded.linkage || [],
      authorization,
      classes,
      proven,
      reported,
      summary: `a merge needs ${REQUIRED_PROVEN_SLOTS.join(' + ')} PROVEN — ${detail}.`
        + (reported.length ? ` Other slots present: ${reported.join(', ')} (not proof).` : ''),
    };
  }

  return {
    ok: true,
    reason: null,
    bundleState: graded.bundle,
    classes,
    proven,
    reported,
    summary: `PROVEN: ${proven.join(', ')}.`
      + (reported.length
        ? ` Present but NOT proof: ${reported.join(', ')} — a PROVIDER_READBACK slot is an unsigned`
          + ' provider statement and is reported, never counted as proof.'
        : ''),
  };
}

module.exports = {
  evaluateBundle, classOf,
  PROVEN_STATUSES, UNPROVEN_ACCEPTED_STATUSES, REQUIRED_PROVEN_SLOTS, REPORTED_SLOTS,
};
