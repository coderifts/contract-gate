'use strict';

/**
 * POST /api/v1/preflight — the v4 (envelope-bound) receipt path. NOT /api/diff, whose v3 receipt is
 * unbound to a change-set body_hash. Fail-closed: any non-2xx or unparseable body throws (the
 * orchestrator turns a throw into a FAIL check).
 */

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.apiUrl               base URL, e.g. https://app.coderifts.com
 * @param {Array}  o.artifacts            diff-derived artifacts (NEVER caller-supplied)
 * @param {object} [o.context]            preflight context (operation/environment/repository/...)
 * @param {typeof fetch} [o.fetchImpl]    injectable fetch (tests)
 * @param {number} [o.timeoutMs]
 * @returns {Promise<object>} parsed preflight response
 */
async function callPreflight({ apiKey, apiUrl, artifacts, context = {}, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error('callPreflight: apiKey is required');
  if (!apiUrl) throw new Error('callPreflight: apiUrl is required');
  if (!Array.isArray(artifacts)) throw new Error('callPreflight: artifacts must be an array');

  const url = `${apiUrl.replace(/\/+$/, '')}/api/v1/preflight`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ artifacts, context }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res || typeof res.status !== 'number') throw new Error('callPreflight: no response');
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`preflight HTTP ${res.status}: ${String(text).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('preflight: response was not JSON');
  }
}

module.exports = { callPreflight, DEFAULT_TIMEOUT_MS };
