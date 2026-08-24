'use strict';

/**
 * cr.monitor.attest.v1 — offline verifier for the contract-gate.
 *
 * Zero-dep (node:crypto only), same Ed25519 path as verify.js receipt verification.
 * Registry is a REQUIRED local file — no network fetch, ever.
 * Wire/signing input MIRRORS app src/verdict-core/monitoring-attestation.js /
 * guard receiptDigestOfToken BYTE-EXACTLY.
 *
 * Honesty: proves a holder of the monitoring key observed this delivery status.
 * Does NOT prove a human read the alert, and does NOT prove the sink targets
 * the right audience.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { sha256hex, keyFromPem } = require('./verify');

const ATTEST_VERSION = 'cr.monitor.attest.v1';
const SIGNING_PREFIX = 'crmonattest.v1';
const ENVELOPE_TAG = 'cr.monitor.attest.v1';

const DELIVERY_STATUSES = Object.freeze(['delivered_acked', 'sent_unacked', 'not_delivered']);
const SINK_KINDS = Object.freeze(['callback', 'http']);
const REQUIRED_FIELDS = Object.freeze([
  'kid', 'decision_id', 'receipt_digest', 'delivery_status', 'sink_kind', 'observed_at',
]);
const OPTIONAL_STRINGS = Object.freeze(['ack_digest']);
const ALLOWED_KEYS = new Set(['v', ...REQUIRED_FIELDS, ...OPTIONAL_STRINGS, 'attempt_count', 'meta']);

const STATUSES = Object.freeze({
  MON_ATTEST_VALID: 'MON_ATTEST_VALID',
  MON_ATTEST_INVALID_SIGNATURE: 'MON_ATTEST_INVALID_SIGNATURE',
  MON_ATTEST_UNKNOWN_KEY: 'MON_ATTEST_UNKNOWN_KEY',
  MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE: 'MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE',
  MON_ATTEST_MALFORMED: 'MON_ATTEST_MALFORMED',
  MON_ATTEST_UNBOUND: 'MON_ATTEST_UNBOUND',
});

const CLOCK_SKEW_LEEWAY_MS = 30_000;

/** BYTE-EXACT with guard receiptDigestOfToken / app receiptDigest. */
function receiptDigest(token) {
  return 'sha256:' + sha256hex(String(token));
}

function scalar(v) {
  return v == null ? '' : String(v);
}

function canonicalMeta(meta) {
  const keys = Object.keys(meta).sort();
  const o = {};
  for (const k of keys) o[k] = meta[k];
  return JSON.stringify(o);
}

function metaOk(meta) {
  if (meta == null) return true;
  if (typeof meta !== 'object' || Array.isArray(meta)) return false;
  const keys = Object.keys(meta);
  if (keys.length > 8) return false;
  for (const k of keys) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 64) return false;
    const v = meta[k];
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') return false;
    if (t === 'string' && (v.length > 256 || v.includes('|'))) return false;
    if (k.includes('|')) return false;
  }
  return true;
}

function signingInput(body) {
  const parts = [
    SIGNING_PREFIX,
    scalar(body.kid),
    scalar(body.decision_id),
    scalar(body.receipt_digest),
    scalar(body.delivery_status),
    body.ack_digest != null && String(body.ack_digest).length > 0 ? String(body.ack_digest) : '',
    scalar(body.sink_kind),
    scalar(body.observed_at),
    body.attempt_count != null ? String(body.attempt_count) : '',
  ];
  if (body.meta && typeof body.meta === 'object') parts.push(canonicalMeta(body.meta));
  return parts.join('|');
}

function fieldHasDelimiter(body) {
  for (const k of [...REQUIRED_FIELDS, ...OPTIONAL_STRINGS]) {
    if (typeof body[k] === 'string' && body[k].includes('|')) return true;
  }
  return false;
}

function fail(status, reason, payload) {
  return { valid: false, status, reason, payload };
}

function okStatus(status, payload) {
  return { valid: true, status, reason: null, payload };
}

function isIssueTimeWithinKeyWindow(ts, keyMeta) {
  if (!keyMeta || keyMeta.status === 'active') return true;
  if (keyMeta.status !== 'retired') return false;
  if (typeof keyMeta.retired_at !== 'string' || keyMeta.retired_at.length === 0) return false;
  if (typeof ts !== 'string' || ts.length === 0) return false;
  const issueMs = Date.parse(ts);
  if (!Number.isFinite(issueMs)) return false;
  if (keyMeta.valid_from) {
    const fromMs = Date.parse(keyMeta.valid_from);
    if (Number.isFinite(fromMs) && issueMs < fromMs) return false;
  }
  const retiredMs = Date.parse(keyMeta.retired_at);
  if (!Number.isFinite(retiredMs)) return false;
  if (issueMs >= retiredMs) return false;
  return true;
}

function resolveMonitoringKey(registry, kid) {
  if (!registry || !Array.isArray(registry.keys) || typeof kid !== 'string' || !kid) return null;
  const matches = registry.keys.filter((k) => k && k.kid === kid && typeof k.public_key_pem === 'string');
  if (matches.length === 0) return null;
  const entry = matches.find((k) => k.status === 'active') || matches[0];
  try {
    return {
      publicKey: keyFromPem(entry.public_key_pem),
      status: entry.status === 'retired' ? 'retired' : 'active',
      valid_from: entry.valid_from || null,
      retired_at: entry.retired_at || null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Load a monitoring-key registry from a LOCAL file only. HTTP(S) is rejected.
 * Shape: { keys: [{ kid, public_key_pem, status, valid_from, retired_at }] }.
 */
function loadMonitoringKeyring(source) {
  if (source == null || String(source).trim() === '') return null;
  const path = String(source).trim();
  if (/^https?:\/\//i.test(path)) {
    throw new Error('monitoring-keyring must be a local file path (no network fetch)');
  }
  const text = fs.readFileSync(path, 'utf8');
  const doc = JSON.parse(text);
  const keys = doc && Array.isArray(doc.keys) ? doc.keys : null;
  if (!keys || keys.length === 0) throw new Error(`no keys[] in monitoring keyring ${path}`);
  for (const k of keys) {
    if (!k || !k.kid || !k.public_key_pem) {
      throw new Error(`monitoring keyring entry missing kid/public_key_pem in ${path}`);
    }
    keyFromPem(k.public_key_pem);
  }
  return doc;
}

function parseAttestToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'malformed_structure' };
  }
  const segments = token.split('|');
  if (segments.length !== 4 || segments.some((s) => !s)) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'malformed_structure' };
  }
  if (segments[0] !== ENVELOPE_TAG) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'unsupported_version' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(segments[2], 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_json' };
  }
  if (payload.v !== ATTEST_VERSION) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'unsupported_version', payload };
  }
  for (const k of REQUIRED_FIELDS) {
    if (typeof payload[k] !== 'string' || payload[k].length === 0) {
      return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'missing_field', payload };
    }
  }
  if (!DELIVERY_STATUSES.includes(payload.delivery_status)) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_delivery_status', payload };
  }
  if (!SINK_KINDS.includes(payload.sink_kind)) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_sink_kind', payload };
  }
  for (const k of OPTIONAL_STRINGS) {
    if (payload[k] != null && typeof payload[k] !== 'string') {
      return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_optional', payload };
    }
  }
  if (payload.attempt_count != null && typeof payload.attempt_count !== 'number') {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_attempt_count', payload };
  }
  if (payload.kid !== segments[1]) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'kid_mismatch', payload };
  }
  for (const k of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(k)) {
      return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'unknown_field', payload };
    }
  }
  if (!metaOk(payload.meta)) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'meta_bounds', payload };
  }
  if (payload.ack_digest != null && payload.ack_digest !== ''
      && !String(payload.ack_digest).startsWith('sha256:')) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_ack_digest', payload };
  }
  if (payload.receipt_digest && !String(payload.receipt_digest).startsWith('sha256:')) {
    return { ok: false, status: STATUSES.MON_ATTEST_MALFORMED, reason: 'bad_receipt_digest', payload };
  }
  return { ok: true, payload, sig: segments[3] };
}

/**
 * Offline monitoring-attestation verifier.
 *
 * @param {string} token
 * @param {object} opts
 * @param {object} opts.registry  { keys: [...] } — REQUIRED, no default fetch
 * @param {object} [opts.intended]  { decision_id?, receipt_digest? }
 * @param {number} [opts.now]
 */
function verifyMonitoringAttestation(token, opts = {}) {
  const parsed = parseAttestToken(token);
  if (!parsed.ok) return fail(parsed.status, parsed.reason, parsed.payload);
  const payload = parsed.payload;
  if (fieldHasDelimiter(payload)) {
    return fail(STATUSES.MON_ATTEST_INVALID_SIGNATURE, 'delimiter_in_field', payload);
  }

  const resolved = resolveMonitoringKey(opts.registry, payload.kid);
  if (!resolved) return fail(STATUSES.MON_ATTEST_UNKNOWN_KEY, 'unknown_kid', payload);

  let sigOk = false;
  try {
    sigOk = crypto.verify(
      null,
      Buffer.from(signingInput(payload), 'utf8'),
      resolved.publicKey,
      Buffer.from(parsed.sig, 'base64url'),
    );
  } catch (_) {
    return fail(STATUSES.MON_ATTEST_INVALID_SIGNATURE, 'signature_error', payload);
  }
  if (!sigOk) return fail(STATUSES.MON_ATTEST_INVALID_SIGNATURE, 'signature_mismatch', payload);

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const observedMs = Date.parse(payload.observed_at);
  if (!Number.isFinite(observedMs)) {
    return fail(STATUSES.MON_ATTEST_MALFORMED, 'bad_timestamp', payload);
  }
  if (observedMs > now + CLOCK_SKEW_LEEWAY_MS) {
    return fail(STATUSES.MON_ATTEST_MALFORMED, 'observed_at_in_future', payload);
  }

  let retiredHistorical = false;
  if (resolved.status === 'retired') {
    if (!isIssueTimeWithinKeyWindow(payload.observed_at, resolved)) {
      return fail(STATUSES.MON_ATTEST_UNKNOWN_KEY, 'retired_key_outside_window', payload);
    }
    retiredHistorical = true;
  }

  const intended = opts.intended && typeof opts.intended === 'object' ? opts.intended : null;
  const wantsCross = !!(intended && (intended.decision_id || intended.receipt_digest));
  if (wantsCross) {
    if (intended.decision_id != null && String(intended.decision_id).length > 0
        && String(intended.decision_id) !== payload.decision_id) {
      return fail(STATUSES.MON_ATTEST_UNBOUND, 'decision_id_mismatch', payload);
    }
    if (intended.receipt_digest != null && String(intended.receipt_digest).length > 0
        && String(intended.receipt_digest) !== payload.receipt_digest) {
      return fail(STATUSES.MON_ATTEST_UNBOUND, 'receipt_digest_mismatch', payload);
    }
  }

  if (retiredHistorical) {
    return okStatus(STATUSES.MON_ATTEST_RETIRED_KEY_VALID_AT_ISSUE, payload);
  }
  return okStatus(STATUSES.MON_ATTEST_VALID, payload);
}

function issueMonitoringAttestation({ privateKey, kid, decision_id, receipt_digest, delivery_status, sink_kind, observed_at, ack_digest, attempt_count, now }) {
  const observed = observed_at || (now != null ? new Date(now) : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = {
    v: ATTEST_VERSION,
    kid: String(kid),
    decision_id: String(decision_id),
    receipt_digest: String(receipt_digest),
    delivery_status: String(delivery_status),
    sink_kind: String(sink_kind || 'callback'),
    observed_at: observed,
  };
  if (ack_digest) body.ack_digest = String(ack_digest);
  if (attempt_count != null) body.attempt_count = Number(attempt_count);
  const sig = crypto.sign(null, Buffer.from(signingInput(body), 'utf8'), privateKey);
  return [
    ENVELOPE_TAG,
    body.kid,
    Buffer.from(JSON.stringify(body), 'utf8').toString('base64url'),
    Buffer.from(sig).toString('base64url'),
  ].join('|');
}

module.exports = {
  ATTEST_VERSION,
  SIGNING_PREFIX,
  ENVELOPE_TAG,
  STATUSES,
  receiptDigest,
  signingInput,
  verifyMonitoringAttestation,
  loadMonitoringKeyring,
  issueMonitoringAttestation,
  sha256hex,
};
