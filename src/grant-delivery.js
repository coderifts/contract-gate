/**
 * 1094 — PR-comment grant delivery. No shared secret to read.
 * Marker binds head_sha; grant binds after_payload_hash.
 */
'use strict';

const MARKER = '<!-- coderifts-grant-v2 -->';
const DELIVERY_VERSION = 'cr.grant.delivery.v1';

function encodeMarker({ head_sha, after_payload_hash, grant }) {
  const body = JSON.stringify({
    v: DELIVERY_VERSION,
    head_sha: String(head_sha),
    after_payload_hash: String(after_payload_hash),
    grant: String(grant),
  });
  return `${MARKER}\n${body}`;
}

function parseMarker(commentBody) {
  if (typeof commentBody !== 'string') return { ok: false, reason: 'not_string' };
  const idx = commentBody.indexOf(MARKER);
  if (idx < 0) return { ok: false, reason: 'no_marker' };
  const json = commentBody.slice(idx + MARKER.length).trim();
  let obj;
  try {
    obj = JSON.parse(json.split('\n')[0] || json);
  } catch (_) {
    return { ok: false, reason: 'bad_json' };
  }
  if (!obj || obj.v !== DELIVERY_VERSION) return { ok: false, reason: 'bad_version' };
  if (typeof obj.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(obj.head_sha)) {
    return { ok: false, reason: 'bad_head_sha' };
  }
  if (typeof obj.grant !== 'string' || obj.grant.length === 0) {
    return { ok: false, reason: 'missing_grant' };
  }
  return { ok: true, head_sha: obj.head_sha, after_payload_hash: obj.after_payload_hash, grant: obj.grant };
}

/**
 * Pick the grant for THIS head_sha. Another SHA → bound_elsewhere (BLOCK).
 */
function selectGrantForHead(comments, headSha) {
  const sha = String(headSha || '');
  const parsed = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = c && (c.body || c);
    const p = parseMarker(typeof body === 'string' ? body : '');
    if (p.ok) parsed.push(p);
  }
  if (parsed.length === 0) return { ok: false, reason: 'grant_not_supplied' };
  const match = parsed.filter((p) => p.head_sha.toLowerCase() === sha.toLowerCase());
  if (match.length === 0) {
    return { ok: false, reason: 'grant_bound_elsewhere', why: 'grant marker head_sha does not match this PR head' };
  }
  return { ok: true, grant: match[match.length - 1].grant, after_payload_hash: match[match.length - 1].after_payload_hash };
}

module.exports = { MARKER, DELIVERY_VERSION, encodeMarker, parseMarker, selectGrantForHead };
