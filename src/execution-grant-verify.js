/**
 * Offline cr.exec.v1 grant verification, inside the gate.
 *
 * REUSE, NOT REIMPLEMENTATION. The Ed25519 machinery, the pinned-keyring loader and the expiry
 * leeway all come from ./verify.js — the same rule that made the hasher a mirror rather than a
 * second implementation. What is mirrored here is only the cr.exec.v1 WIRE FORMAT (segments,
 * signing input, field list), because that is a format, not an algorithm.
 *
 * THE GRANT RETIRED-KEY RULE IS NOT THE RECEIPT RULE. Taken verbatim from the app kernel,
 * coderifts-app/src/verdict-core/execution-grant.js:236-241:
 *
 *     // Live execution permission: retired keys never yield GRANT_CURRENT
 *     // (receipts may forensically verify inside the window; grants may not).
 *     if (entry.status === 'retired') {
 *       return { valid: false, status: 'UNKNOWN_KEY', reason: 'retired_kid', payload };
 *     }
 *
 * verify.js deriveStatus does the OPPOSITE for receipts (RETIRED_KEY_VALID_AT_ISSUE is a PASSING
 * historical class). Calling deriveStatus here would silently grant live permission from a retired
 * key. It is not called, and this comment is why.
 */
'use strict';

const crypto = require('node:crypto');
const { resolveEntry, isExpiredAt, CLOCK_SKEW_LEEWAY_MS } = require('./verify.js');

/** MIRRORED wire format — coderifts-app src/verdict-core/execution-grant.js. */
const GRANT_VERSION = 'cr.exec.v1';
const SIGNING_PREFIX = 'crexec.v1';
const SIGNED_FIELDS = Object.freeze([
  'kid', 'receipt_digest', 'scope_hash', 'audience', 'operation', 'target_id', 'jti', 'iat', 'exp',
]);

const scalar = (v) => (v == null ? '' : String(v));
const hasStateNonce = (b) => !!(b && typeof b.state_nonce === 'string' && b.state_nonce.length > 0);

function signingInput(body) {
  const parts = [
    SIGNING_PREFIX,
    scalar(body.kid), scalar(body.receipt_digest), scalar(body.scope_hash),
    scalar(body.audience), scalar(body.operation), scalar(body.target_id),
    scalar(body.jti), scalar(body.iat), scalar(body.exp),
  ];
  // ATOMIC: appended only when non-empty, so BEARER signing input stays byte-identical.
  if (hasStateNonce(body)) parts.push(scalar(body.state_nonce));
  return parts.join('|');
}

function fieldHasDelimiter(body) {
  for (const k of SIGNED_FIELDS) {
    if (typeof body[k] === 'string' && body[k].includes('|')) return true;
  }
  return hasStateNonce(body) && body.state_nonce.includes('|');
}

function parseGrantToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, status: 'MALFORMED', reason: 'malformed_structure' };
  }
  const segments = token.split('.');
  if (segments.length !== 2 || segments.some((s) => !s)) {
    return { ok: false, status: 'MALFORMED', reason: 'malformed_structure' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, status: 'MALFORMED', reason: 'bad_json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, status: 'MALFORMED', reason: 'bad_json' };
  }
  if (payload.v !== GRANT_VERSION) {
    return { ok: false, status: 'MALFORMED', reason: 'unsupported_version', payload };
  }
  for (const k of SIGNED_FIELDS) {
    if (typeof payload[k] !== 'string') {
      return { ok: false, status: 'MALFORMED', reason: 'missing_field', payload };
    }
  }
  if (payload.state_nonce != null && typeof payload.state_nonce !== 'string') {
    return { ok: false, status: 'MALFORMED', reason: 'bad_state_nonce', payload };
  }
  const allowed = new Set(['v', ...SIGNED_FIELDS, 'state_nonce']);
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) return { ok: false, status: 'MALFORMED', reason: 'unknown_field', payload };
  }
  return { ok: true, payload, sig: segments[1] };
}

/**
 * @param {string} token   cr.exec.v1 grant
 * @param {object} opts    { keyring: Map (from verify.js loadKeyring), now?, context? }
 * @returns {{ valid:boolean, status:string, reason:(string|null), payload?:object }}
 */
function verifyExecutionGrant(token, opts = {}) {
  const { peekGrantVersion, verifyExecutionGrantV2 } = require('./execution-grant-v2');
  if (peekGrantVersion(token) === 'cr.exec.v2') {
    return verifyExecutionGrantV2(token, opts);
  }
  const parsed = parseGrantToken(token);
  if (!parsed.ok) return { valid: false, status: parsed.status, reason: parsed.reason, payload: parsed.payload };
  const { payload, sig } = parsed;

  if (fieldHasDelimiter(payload)) {
    return { valid: false, status: 'INVALID_SIGNATURE', reason: 'delimiter_in_field', payload };
  }

  // REUSED: verify.js resolveEntry, against the same pinned keyring loadKeyring builds.
  const entry = resolveEntry({ keyring: opts.keyring || null, expectedKid: null, publicKey: opts.publicKey || null }, payload);
  if (!entry || !entry.publicKey) {
    return { valid: false, status: 'UNKNOWN_KEY', reason: 'unknown_kid', payload };
  }
  // GRANT RULE (app kernel, see header): a retired kid is never live permission.
  if (entry.status === 'retired') {
    return { valid: false, status: 'UNKNOWN_KEY', reason: 'retired_kid', payload };
  }

  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(signingInput(payload), 'utf8'), entry.publicKey, Buffer.from(sig, 'base64url'));
  } catch (_) {
    return { valid: false, status: 'INVALID_SIGNATURE', reason: 'signature_error', payload };
  }
  if (!ok) return { valid: false, status: 'INVALID_SIGNATURE', reason: 'signature_mismatch', payload };

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const expMs = Date.parse(payload.exp);
  const iatMs = Date.parse(payload.iat);
  if (!Number.isFinite(expMs) || !Number.isFinite(iatMs)) {
    return { valid: false, status: 'MALFORMED', reason: 'bad_timestamp', payload };
  }
  // REUSED: verify.js isExpiredAt — one leeway policy, not a second clock rule.
  if (isExpiredAt(expMs, now, opts.context)) {
    return { valid: false, status: 'GRANT_EXPIRED', reason: 'expired', payload };
  }
  if (iatMs - now > CLOCK_SKEW_LEEWAY_MS) {
    return { valid: false, status: 'GRANT_EXPIRED', reason: 'iat_in_future', payload };
  }
  if (!payload.receipt_digest || !payload.receipt_digest.startsWith('sha256:')) {
    return { valid: false, status: 'GRANT_UNBOUND', reason: 'missing_receipt_digest', payload };
  }
  return { valid: true, status: 'GRANT_CURRENT', reason: null, payload };
}

module.exports = {
  verifyExecutionGrant, parseGrantToken, signingInput,
  GRANT_VERSION, SIGNING_PREFIX, SIGNED_FIELDS,
};
