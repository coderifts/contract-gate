'use strict';

/**
 * 1961 TAG 1 — FINDING THE RECEIPT THAT BELONGS TO A COMMIT.
 *
 * ⚠ MEASURED FIRST, 2026-09-23: there was no convention. `commit_observation` (a GuardOutcome
 * field) and `after_state_token` already join a receipt to a commit AT DECISION TIME, inside the
 * guard — but nothing answered the other direction, "given this SHA in history, which receipt
 * authorised it". Zero occurrences of a receipt trailer or a receipt sidecar across the app, this
 * repository and contract-gate. The evidence existed; the link did not.
 *
 * TWO CARRIERS, AND THE PRECEDENCE IS THE INTERESTING PART:
 *
 *   trailer   `CodeRifts-Receipt: <token>` in the commit message. Covered by the commit SHA, so
 *             it cannot be edited after the fact — but for the same reason it can only be written
 *             when the commit is created.
 *   sidecar   `.coderifts/receipts/<sha>.json`. Addable afterwards without rewriting history, and
 *             it can carry the ENVELOPE, which a trailer cannot — v4 binds `bh` to a canonical
 *             envelope body, and checking that binding needs the envelope itself.
 *
 * ⚠ TRAILER WINS, AND A DISAGREEMENT IS REFUSED RATHER THAN RESOLVED. The trailer is inside the
 * signed-over commit object and the sidecar is a file anyone can edit, so where both exist the
 * immutable one is authoritative. But when the two DISAGREE, silently preferring the trailer
 * would hide precisely the tampering the precedence rule exists to make visible — so the conflict
 * is reported and neither is used.
 *
 * ⚠ AND THE CARRIER PROVES NOTHING BY ITSELF. Whichever one delivers the token, the token is then
 * verified exactly as if it had been pasted on the command line: same statuses, same exit codes,
 * same offline default. A forged sidecar yields INVALID_SIGNATURE, not a false pass. The sidecar
 * is a POINTER; the signature is the authority.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TRAILER_KEY = 'CodeRifts-Receipt';
const SIDECAR_DIR = path.join('.coderifts', 'receipts');

/** A receipt token is `<base64url>.<base64url>`. Used to reject obvious junk before verifying. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Resolve an abbreviated SHA to the full 40 characters.
 *
 * ⚠ THE SIDECAR IS KEYED ON THE FULL SHA, deliberately: abbreviations collide, and a verifier
 * that resolved one itself would be guessing which commit the operator meant. Resolution happens
 * HERE, through git, which knows.
 */
function resolveSha(ref, cwd) {
  return git(['rev-parse', `${ref}^{commit}`], cwd);
}

/** The trailer value, unfolded. Git folds long values on read; a receipt token is long. */
function receiptFromTrailer(sha, cwd) {
  const raw = git(['log', '-1', `--format=%(trailers:key=${TRAILER_KEY},valueonly)`, sha], cwd);
  if (!raw) return null;
  // Unfold: git wraps continuation lines with leading whitespace. A token has no whitespace in it.
  const token = raw.split('\n').map((l) => l.trim()).join('');
  return token || null;
}

/** The sidecar, if present. Returns `{ token, envelope }` so the envelope survives. */
function receiptFromSidecar(sha, cwd) {
  const file = path.join(cwd, SIDECAR_DIR, `${sha}.json`);
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // ⚠ A malformed sidecar is NOT "no sidecar". Treating it as absent would let a corrupted
    // pointer silently fall through to the trailer, or to "nothing found" — both of which read
    // as an innocent absence rather than as the broken file it is.
    throw new Error(`sidecar ${file} is not valid JSON: ${err.message}`);
  }
  const token = doc && (doc.receipt || doc.token);
  if (!token) throw new Error(`sidecar ${file} has no "receipt" field`);
  return { token: String(token), envelope: (doc && doc.envelope) || null, file };
}

/**
 * Find the receipt attached to `ref`.
 *
 * @returns {{ sha, token, envelope, carrier: 'trailer'|'sidecar'|'both' }}
 * @throws on: not a repo, unknown ref, nothing attached, a broken sidecar, or a CONFLICT.
 */
function receiptForCommit(ref, { cwd = process.cwd() } = {}) {
  let sha;
  try {
    sha = resolveSha(ref, cwd);
  } catch (err) {
    throw new Error(`cannot resolve ${ref} in ${cwd}: ${String(err.message).split('\n')[0]}`);
  }

  const trailer = receiptFromTrailer(sha, cwd);
  const sidecar = receiptFromSidecar(sha, cwd);

  if (trailer && sidecar) {
    if (trailer !== sidecar.token) {
      throw new Error(
        `receipt conflict for ${sha}: the commit trailer and ${sidecar.file} carry DIFFERENT `
        + 'receipts. The trailer is covered by the commit SHA and the sidecar is not, so they '
        + 'should never disagree — resolve it deliberately rather than letting one win silently.',
      );
    }
    return { sha, token: trailer, envelope: sidecar.envelope, carrier: 'both' };
  }
  if (trailer) return { sha, token: trailer, envelope: null, carrier: 'trailer' };
  if (sidecar) return { sha, token: sidecar.token, envelope: sidecar.envelope, carrier: 'sidecar' };

  throw new Error(
    `no receipt attached to ${sha}: no ${TRAILER_KEY} trailer and no ${SIDECAR_DIR}/${sha}.json. `
    + 'That means no receipt was ATTACHED — it does not mean none exists. See '
    + 'docs/receipt-commit-binding.md.',
  );
}

module.exports = { TRAILER_KEY, SIDECAR_DIR, TOKEN_SHAPE, receiptForCommit, resolveSha, receiptFromTrailer, receiptFromSidecar };
