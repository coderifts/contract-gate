/**
 * require-grant — store-side coverage check (roadmap 1010 / panel C1).
 *
 * THE CLAIM THIS SUPPORTS, and its exact shape: "every changed governed path in this PR is
 * covered by a valid execution grant bound to this repo and operation, or the run BLOCKED."
 * The subject is the change set, never the agent.
 *
 * WHAT WE BIND. A cr.exec.v1 grant binds operation ∥ target_id ∥ after_payload (NUL-joined,
 * sha256). The after-payload is the artifact AFTER-content — the same bytes
 * afterPayloadCanonical() joins server-side. The gate already reads head blobs
 * (artifacts.js deriveArtifactsFromDiff), so it can recompute that preimage from the PR's real
 * head diff and compare. ONE hasher, mirrored byte-for-byte from the app: a second, subtly
 * different hasher would mint false mismatches, which is the C2 lesson.
 *
 * UNDECIDABLE IS NOT COVERED. An unreadable blob cannot be hashed, so it cannot be shown to be
 * covered. It BLOCKS as path_unreadable — never silently treated as covered.
 */
'use strict';

const crypto = require('node:crypto');

/** MIRRORED from coderifts-app src/verdict-core/execution-grant.js. Must stay byte-exact. */
const NUL = '\x1f';

function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/** MIRRORED: specStr — string as-is, object JSON.stringify (insertion order, NOT RFC 8785). */
function specStr(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** MIRRORED: afterPayloadCanonical — sort by (type, id) with NUL, join after-sides with NUL. */
function afterPayloadCanonical(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts.slice() : [];
  list.sort((x, y) => {
    const kx = `${x && x.type != null ? x.type : ''}${NUL}${x && x.id != null ? x.id : ''}`;
    const ky = `${y && y.type != null ? y.type : ''}${NUL}${y && y.id != null ? y.id : ''}`;
    return kx < ky ? -1 : (kx > ky ? 1 : 0);
  });
  return list.map((a) => specStr(a && a.after)).join(NUL);
}

/** MIRRORED: computeScopeHash. */
function computeScopeHash({ operation, target_id, after_payload }) {
  const preimage = [
    operation == null ? '' : String(operation),
    target_id == null ? '' : String(target_id),
    after_payload == null ? '' : String(after_payload),
  ].join(NUL);
  return `sha256:${sha256hex(preimage)}`;
}

/** Distinct, quotable failure classes. Never collapse these — each has a different remedy. */
const COVERAGE_REASONS = Object.freeze({
  NO_GRANT_SUPPLIED: 'grant_not_supplied',
  NOT_COVERED: 'grant_does_not_cover_path',
  WRONG_BINDING: 'grant_bound_elsewhere',
  EXPIRED: 'grant_expired',
  UNREADABLE: 'path_unreadable',
  MALFORMED: 'grant_malformed',
  UNVERIFIED: 'grant_unverified',
});

/**
 * @param {object} o
 * @param {Array} o.governedArtifacts  changed governed artifacts: { id, type, after, unreadable? }
 * @param {object|null} o.grantResult  result of verifyExecutionGrant (offline)
 * @param {string} o.operation         operation this PR represents (e.g. 'merge')
 * @param {string} o.repository        owner/repo this run is for
 * @returns {{ covered:boolean, reason:(string|null), why:(string|null), detail:object }}
 */
function evaluateGrantCoverage({ governedArtifacts, grantResult, operation, repository }) {
  const artifacts = Array.isArray(governedArtifacts) ? governedArtifacts : [];

  // UNDECIDABLE FIRST: an unreadable path can never be shown covered.
  const unreadable = artifacts.filter((a) => a && a.unreadable === true).map((a) => a.id);
  if (unreadable.length > 0) {
    return {
      covered: false, reason: COVERAGE_REASONS.UNREADABLE,
      why: `governed path(s) could not be read at head, so their after-content cannot be hashed and cannot be shown to be covered by any grant: ${unreadable.join(', ')}. Unreadable is UNDECIDABLE — it is never treated as covered.`,
      detail: { unreadable },
    };
  }

  if (artifacts.length === 0) {
    return { covered: true, reason: null, why: 'no governed path changed in this diff', detail: { governed_paths: [] } };
  }

  const paths = artifacts.map((a) => a.id);

  if (!grantResult) {
    return {
      covered: false, reason: COVERAGE_REASONS.NO_GRANT_SUPPLIED,
      why: `require-grant is true and ${artifacts.length} governed path(s) changed (${paths.join(', ')}), but no execution grant was supplied to the workflow.`,
      detail: { governed_paths: paths },
    };
  }
  if (grantResult.valid !== true) {
    const byStatus = {
      GRANT_EXPIRED: COVERAGE_REASONS.EXPIRED,
      GRANT_SCOPE_MISMATCH: COVERAGE_REASONS.NOT_COVERED,
      GRANT_WRONG_AUDIENCE: COVERAGE_REASONS.WRONG_BINDING,
      GRANT_UNBOUND: COVERAGE_REASONS.WRONG_BINDING,
      GRANT_MALFORMED: COVERAGE_REASONS.MALFORMED,
    };
    const reason = byStatus[grantResult.status] || COVERAGE_REASONS.UNVERIFIED;
    return {
      covered: false, reason,
      why: `the supplied execution grant did not verify: ${grantResult.status}`
        + (grantResult.reason ? ` (${grantResult.reason})` : '')
        + `. Governed paths in this diff: ${paths.join(', ')}.`,
      detail: { governed_paths: paths, grant_status: grantResult.status },
    };
  }

  const payload = grantResult.payload || {};

  if (operation && payload.operation && payload.operation !== operation) {
    return {
      covered: false, reason: COVERAGE_REASONS.WRONG_BINDING,
      why: `the grant is bound to operation "${payload.operation}" but this run is "${operation}". A grant for one operation does not authorize another.`,
      detail: { governed_paths: paths, grant_operation: payload.operation, run_operation: operation },
    };
  }
  if (repository && payload.audience && payload.audience !== repository) {
    return {
      covered: false, reason: COVERAGE_REASONS.WRONG_BINDING,
      why: `the grant audience is "${payload.audience}" but this run is for "${repository}".`,
      detail: { governed_paths: paths, grant_audience: payload.audience, run_repository: repository },
    };
  }

  // The binding test: recompute the scope hash from the PR's REAL head content.
  const expected = computeScopeHash({
    operation: payload.operation,
    target_id: payload.target_id,
    after_payload: afterPayloadCanonical(artifacts),
  });
  if (expected !== payload.scope_hash) {
    return {
      covered: false, reason: COVERAGE_REASONS.NOT_COVERED,
      why: `the grant does not cover this change set: recomputed scope_hash from the PR head content does not match the hash the grant was minted against. The content changed after the grant was issued, or the grant is for a different change set. Governed paths: ${paths.join(', ')}.`,
      detail: { governed_paths: paths, expected_scope_hash: expected, grant_scope_hash: payload.scope_hash || null },
    };
  }

  return {
    covered: true, reason: null,
    why: `every changed governed path is covered by a valid grant bound to operation "${payload.operation}" and target "${payload.target_id}"`,
    detail: { governed_paths: paths, scope_hash: expected },
  };
}

module.exports = {
  evaluateGrantCoverage, COVERAGE_REASONS,
  afterPayloadCanonical, computeScopeHash, specStr, NUL,
};
