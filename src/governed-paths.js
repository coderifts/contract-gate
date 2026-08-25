/**
 * Which changed paths are GOVERNED for require-grant.
 *
 * A path is governed when the single classifier calls it a contract artifact AND it changed in
 * this PR. Nothing here invents a path list: classification is @coderifts/contract-path
 * (mirrored in ./contract-path.js), and the change set comes from the diff the gate already reads.
 *
 * UNDECIDABLE SURVIVES. deriveArtifactsFromDiff distinguishes absent / present / unreadable. An
 * unreadable blob is carried through as { unreadable: true } so evaluateGrantCoverage can BLOCK
 * on it. It is never dropped — dropping it would silently convert "we could not look" into
 * "nothing to cover", which is the failure this whole flag exists to prevent.
 */
'use strict';

const { looksLikeContractPath, typeForPath } = require('./contract-path.js');

/**
 * @param {object} o
 * @param {Array<{path:string, after?:string, unreadable?:boolean}>} o.changed  changed files at head
 * @returns {Array<{id:string, type:string, after?:string, unreadable?:boolean}>}
 */
function deriveGovernedArtifacts({ changed }) {
  const list = Array.isArray(changed) ? changed : [];
  const out = [];
  for (const f of list) {
    const p = f && typeof f.path === 'string' ? f.path : '';
    if (!p || !looksLikeContractPath(p)) continue;
    const entry = { id: p, type: typeForPath(p) };
    if (f.unreadable === true) entry.unreadable = true;
    else entry.after = f.after == null ? '' : String(f.after);
    out.push(entry);
  }
  // Stable order so the recomputed after-payload is deterministic across runs.
  out.sort((a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
  return out;
}

module.exports = { deriveGovernedArtifacts };
