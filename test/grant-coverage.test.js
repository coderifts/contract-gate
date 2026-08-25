'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  evaluateGrantCoverage, COVERAGE_REASONS,
  afterPayloadCanonical, computeScopeHash,
} = require('../src/grant-coverage.js');

/**
 * THE C2 LESSON, MADE CHECKABLE. The gate mirrors the app's hasher. If the two ever diverge, this
 * gate mints false mismatches and blocks correct changes. Prove byte-exactness against the app's
 * REAL implementation, not against a copy of the expectation.
 */
const APP = path.join(process.env.HOME, 'coderifts-app', 'src', 'verdict-core', 'execution-grant.js');
let app = null;
try { app = require(APP); } catch { /* app repo absent — sibling tests skip, loudly */ }

test('MIRROR: afterPayloadCanonical is byte-identical to the app implementation', (t) => {
  if (!app) return t.skip('coderifts-app not present next to this repo — mirror unverified');
  const cases = [
    [{ id: 'a', type: 'openapi', after: 'x: 1' }],
    [{ id: 'b', type: 'openapi', after: 'y' }, { id: 'a', type: 'openapi', after: 'x' }],
    [{ id: 'a', type: 'graphql', after: { k: 1 } }],
    [{ id: 'a', type: 'openapi', after: null }],
    [],
  ];
  for (const c of cases) {
    assert.equal(afterPayloadCanonical(c), app.afterPayloadCanonical(c), JSON.stringify(c));
  }
});

test('MIRROR: computeScopeHash is byte-identical to the app implementation', (t) => {
  if (!app) return t.skip('coderifts-app not present next to this repo — mirror unverified');
  const arg = { operation: 'merge', target_id: 'openapi.yaml', after_payload: 'paths: {}' };
  assert.equal(computeScopeHash(arg), app.computeScopeHash(arg));
});

const ART = [{ id: 'openapi.yaml', type: 'openapi', after: 'paths: {}' }];
const scopeOf = (arts, operation = 'merge', target_id = 'openapi.yaml') =>
  computeScopeHash({ operation, target_id, after_payload: afterPayloadCanonical(arts) });

const grant = (over = {}) => ({
  valid: true, status: 'GRANT_CURRENT', reason: null,
  payload: { operation: 'merge', target_id: 'openapi.yaml', audience: 'acme/api', scope_hash: scopeOf(ART), ...over },
});

test('covers when the grant matches the recomputed head content', () => {
  const r = evaluateGrantCoverage({ governedArtifacts: ART, grantResult: grant(), operation: 'merge', repository: 'acme/api' });
  assert.equal(r.covered, true);
  assert.equal(r.reason, null);
});

test('FAILURE CLASS: no grant supplied', () => {
  const r = evaluateGrantCoverage({ governedArtifacts: ART, grantResult: null, operation: 'merge', repository: 'acme/api' });
  assert.equal(r.covered, false);
  assert.equal(r.reason, COVERAGE_REASONS.NO_GRANT_SUPPLIED);
});

test('FAILURE CLASS: grant does not cover this path (content changed after issuance)', () => {
  const changed = [{ id: 'openapi.yaml', type: 'openapi', after: 'paths: {/x: {}}' }];
  const r = evaluateGrantCoverage({ governedArtifacts: changed, grantResult: grant(), operation: 'merge', repository: 'acme/api' });
  assert.equal(r.reason, COVERAGE_REASONS.NOT_COVERED);
  assert.match(r.why, /content changed after the grant was issued/);
});

test('FAILURE CLASS: grant bound to a different operation', () => {
  const r = evaluateGrantCoverage({ governedArtifacts: ART, grantResult: grant({ operation: 'deploy' }), operation: 'merge', repository: 'acme/api' });
  assert.equal(r.reason, COVERAGE_REASONS.WRONG_BINDING);
  assert.match(r.why, /bound to operation "deploy"/);
});

test('FAILURE CLASS: grant bound to a different repo', () => {
  const r = evaluateGrantCoverage({ governedArtifacts: ART, grantResult: grant({ audience: 'other/repo' }), operation: 'merge', repository: 'acme/api' });
  assert.equal(r.reason, COVERAGE_REASONS.WRONG_BINDING);
});

test('FAILURE CLASS: grant expired', () => {
  const r = evaluateGrantCoverage({ governedArtifacts: ART, grantResult: { valid: false, status: 'GRANT_EXPIRED', reason: 'expired' }, operation: 'merge', repository: 'acme/api' });
  assert.equal(r.reason, COVERAGE_REASONS.EXPIRED);
});

test('FAILURE CLASS: unreadable path is UNDECIDABLE, never covered', () => {
  const arts = [{ id: 'openapi.yaml', type: 'openapi', unreadable: true }];
  const r = evaluateGrantCoverage({ governedArtifacts: arts, grantResult: grant(), operation: 'merge', repository: 'acme/api' });
  assert.equal(r.covered, false);
  assert.equal(r.reason, COVERAGE_REASONS.UNREADABLE);
  assert.match(r.why, /never treated as covered/);
});

test('unreadable outranks a valid grant — order matters', () => {
  const arts = [{ id: 'a.yaml', type: 'openapi', after: 'x' }, { id: 'b.yaml', type: 'openapi', unreadable: true }];
  const r = evaluateGrantCoverage({ governedArtifacts: arts, grantResult: grant(), operation: 'merge', repository: 'acme/api' });
  assert.equal(r.reason, COVERAGE_REASONS.UNREADABLE);
});

test('no governed path changed → covered vacuously, and says so', () => {
  const r = evaluateGrantCoverage({ governedArtifacts: [], grantResult: null, operation: 'merge', repository: 'acme/api' });
  assert.equal(r.covered, true);
  assert.match(r.why, /no governed path changed/);
});

test('every failure class is distinct — none collapse into another', () => {
  const vals = Object.values(COVERAGE_REASONS);
  assert.equal(new Set(vals).size, vals.length);
});
