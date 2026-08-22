'use strict';

/**
 * Gate-path completeness claim (ID637 host claim on context.completeness).
 *
 * The gate already derived artifacts from git (authoritative for THIS path only).
 * This module restates that set as the existing completeness claim so the server
 * can fail-closed when artifacts ⊂ derived leaves (require_full_coverage).
 *
 * Honesty: this is still a HOST claim (the gate is the host). Server mode stays
 * ATTESTED_UNVERIFIED — not SERVER_DERIVED (no ID811 binding-store). Not a
 * generic-MCP completeness proof.
 *
 * Request-only: `source` is not copied into the signed envelope.
 */

function leafPath(artifact) {
  if (!artifact || typeof artifact !== 'object') return '';
  if (typeof artifact.path === 'string' && artifact.path.trim()) return artifact.path.trim();
  const type = typeof artifact.type === 'string' ? artifact.type : 'unknown';
  const id = typeof artifact.id === 'string' ? artifact.id : 'unknown';
  return `${type}:${id}`;
}

function leafChangeType(artifact) {
  const before = artifact && artifact.before != null ? String(artifact.before) : '';
  const after = artifact && artifact.after != null ? String(artifact.after) : '';
  if (!before && after) return 'added';
  if (before && !after) return 'deleted';
  return 'modified';
}

/**
 * @param {Array<{id?:string,type?:string,path?:string,before?:string,after?:string}>} artifacts
 * @returns {{ leaves: object[], completeness_count: number, require_full_coverage: true, source: 'gate-derived' }}
 */
function buildGateCompletenessClaim(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const leaves = list.map((a) => ({
    path: leafPath(a),
    before: a && a.before != null ? a.before : '',
    after: a && a.after != null ? a.after : '',
    change_type: leafChangeType(a),
  })).filter((L) => L.path);
  return {
    leaves,
    completeness_count: leaves.length,
    require_full_coverage: true,
    source: 'gate-derived',
  };
}

module.exports = {
  leafPath,
  buildGateCompletenessClaim,
};
