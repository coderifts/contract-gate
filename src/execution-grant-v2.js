/**
 * cr.exec.v2 wire format — MIRRORED from coderifts-app/src/verdict-core/execution-grant-v2.js.
 * Ed25519 via ./verify.js (same as v1 grant verifier). Not an npm import of receipt-verifier.
 */
'use strict';

const crypto = require('node:crypto');
const { resolveEntry } = require('./verify.js');

const GRANT_VERSION_V2 = 'cr.exec.v2';
const SIGNING_PREFIX_V2 = 'crexec.v2';
const TARGET_SCHEMES = Object.freeze(['fs', 'git', 'api', 'db', 'registry', 'deploy']);
const REQUIRED_STRINGS = Object.freeze([
  'v', 'kid', 'grant_id', 'receipt_hash', 'tenant_id', 'executor_id', 'adapter_id',
  'operation', 'target_uri', 'expected_state_token', 'after_payload_hash',
  'nonce_hash', 'policy_hash', 'audience_hash', 'not_before', 'expires_at',
]);

function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${t}`);
}

function canonicalizeTargetUri(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const m = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^?#]*)$/);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (!TARGET_SCHEMES.includes(scheme)) return null;
  let rest = m[2];
  if (/^[^\s/]*:/.test(rest) && rest.includes('@') && scheme !== 'git') return null;
  if (rest.includes('..') || rest.includes('//') || /\s/.test(rest)) return null;
  if (rest.endsWith('/') && rest.length > 1) rest = rest.replace(/\/+$/, '');
  return `${scheme}://${rest}`;
}

function signingInputV2(body) {
  return `${SIGNING_PREFIX_V2}|${canonicalJson(body)}`;
}

function parseGrantTokenV2(token) {
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
  if (payload.v !== GRANT_VERSION_V2) {
    return { ok: false, status: 'MALFORMED', reason: 'unsupported_version', payload };
  }
  for (const k of REQUIRED_STRINGS) {
    if (typeof payload[k] !== 'string' || payload[k].length === 0) {
      return { ok: false, status: 'MALFORMED', reason: 'missing_field', payload };
    }
  }
  if (!Number.isInteger(payload.max_attempts) || payload.max_attempts < 1) {
    return { ok: false, status: 'MALFORMED', reason: 'bad_max_attempts', payload };
  }
  const allowed = new Set([...REQUIRED_STRINGS, 'max_attempts']);
  for (const k of Object.keys(payload)) {
    if (!allowed.has(k)) return { ok: false, status: 'MALFORMED', reason: 'unknown_field', payload };
  }
  if (!canonicalizeTargetUri(payload.target_uri)) {
    return { ok: false, status: 'MALFORMED', reason: 'bad_target_uri', payload };
  }
  return { ok: true, payload, sig: segments[1] };
}

function verifyExecutionGrantV2(token, opts = {}) {
  const parsed = parseGrantTokenV2(token);
  if (!parsed.ok) {
    return { valid: false, status: parsed.status, reason: parsed.reason, payload: parsed.payload };
  }
  const payload = parsed.payload;
  const entry = resolveEntry(
    { keyring: opts.keyring || null, expectedKid: null, publicKey: opts.publicKey || null },
    payload,
  );
  if (!entry || !entry.publicKey) {
    return { valid: false, status: 'UNKNOWN_KEY', reason: 'unknown_kid', payload };
  }
  if (entry.status === 'retired') {
    return { valid: false, status: 'UNKNOWN_KEY', reason: 'retired_kid', payload };
  }
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(signingInputV2(payload), 'utf8'),
      entry.publicKey,
      Buffer.from(parsed.sig, 'base64url'),
    );
  } catch (_) {
    return { valid: false, status: 'INVALID_SIGNATURE', reason: 'signature_error', payload };
  }
  if (!ok) return { valid: false, status: 'INVALID_SIGNATURE', reason: 'signature_mismatch', payload };

  const intended = opts.intended && typeof opts.intended === 'object' ? opts.intended : {};
  if (intended.executor_id && payload.executor_id !== String(intended.executor_id)) {
    return { valid: false, status: 'GRANT_UNBOUND', reason: 'executor_mismatch', payload };
  }
  if (intended.target_uri) {
    const want = canonicalizeTargetUri(String(intended.target_uri)) || String(intended.target_uri);
    if (payload.target_uri !== want) {
      return { valid: false, status: 'GRANT_UNBOUND', reason: 'target_mismatch', payload };
    }
  }
  if (intended.audience) {
    const cryptoHash = crypto.createHash('sha256').update(String(intended.audience), 'utf8').digest('hex');
    if (payload.audience_hash !== `sha256:${cryptoHash}`) {
      return { valid: false, status: 'GRANT_UNBOUND', reason: 'audience_mismatch', payload };
    }
  }
  return { valid: true, status: 'GRANT_CURRENT', reason: null, payload };
}

function peekGrantVersion(token) {
  try {
    const seg = String(token || '').split('.')[0];
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return payload && payload.v;
  } catch (_) {
    return null;
  }
}

module.exports = {
  GRANT_VERSION_V2, parseGrantTokenV2, verifyExecutionGrantV2, peekGrantVersion, canonicalizeTargetUri,
};
