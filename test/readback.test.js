'use strict';

/**
 * Readback: distinguishing "the required check is green" from "the gate made it green".
 *
 * The fixture is the shape the GitHub API actually returned for coderifts/demo on 2026-09-01:
 * one required context recorded with `app_id: null`, and three check-runs on the PR head posted
 * by two different apps. That measurement is the reason this script exists, so it is the fixture
 * rather than an invented one.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeReadback, render, READBACK } = require('../scripts/readback.js');

/** GET /repos/coderifts/demo/branches/main/protection — measured 2026-09-01. */
const PROTECTION = Object.freeze({
  required_status_checks: {
    strict: false,
    contexts: ['CodeRifts / contract-gate'],
    checks: [{ context: 'CodeRifts / contract-gate', app_id: null }],
  },
  enforce_admins: { enabled: false },
});

/** GET /repos/coderifts/demo/commits/<head>/check-runs -> .check_runs — measured, same day. */
const CHECK_RUNS = Object.freeze([
  { name: 'CodeRifts / contract-gate (Action)', conclusion: 'failure', app: { slug: 'github-actions', id: 15368 } },
  { name: 'contract-gate (Action)', conclusion: 'failure', app: { slug: 'github-actions', id: 15368 } },
  { name: 'CodeRifts / contract-gate', conclusion: 'failure', app: { slug: 'coderifts', id: 2860592 } },
]);

describe('readback — the measured repository state', () => {
  const r = analyzeReadback({ protection: PROTECTION, checkRuns: CHECK_RUNS });

  it('reports the required context as NOT source-bound', () => {
    assert.equal(r.required.length, 1);
    assert.equal(r.required[0].context, 'CodeRifts / contract-gate');
    assert.equal(r.required[0].bound_to_source, false);
    assert.equal(r.required[0].bound_app_id, null);
  });

  it('names it as satisfiable by any poster', () => {
    assert.deepEqual(r.name_only_contexts, ['CodeRifts / contract-gate']);
  });

  it('EXACT: one poster carries that exact name, and it is the App, not the Action', () => {
    assert.equal(r.required[0].status, READBACK.EXACT);
    assert.deepEqual(r.required[0].posters, [
      { app_slug: 'coderifts', app_id: 2860592, conclusion: 'failure' },
    ]);
  });

  it('the Action\'s two check-runs do not satisfy the required context — different names', () => {
    // Both are failures today, but the point stands on name alone: neither is the required context.
    const names = r.required.map((x) => x.context);
    assert.ok(!names.includes('contract-gate (Action)'));
    assert.ok(!names.includes('CodeRifts / contract-gate (Action)'));
  });

  it('records enforce_admins and strict as measured', () => {
    assert.equal(r.enforce_admins, false);
    assert.equal(r.strict_up_to_date, false);
  });
});

describe('readback — the question the UI cannot answer', () => {
  it('green + posted by another app is reported as green AND not-the-expected-app', () => {
    const foreign = [{ name: 'CodeRifts / contract-gate', conclusion: 'success', app: { slug: 'some-other-app', id: 99 } }];
    const r = analyzeReadback({ protection: PROTECTION, checkRuns: foreign, expectApp: 'coderifts' });
    assert.equal(r.required[0].green, true, 'branch protection is satisfied');
    assert.equal(r.required[0].posted_by_expected_app, false, 'but not by the gate');
    assert.equal(r.required[0].status, READBACK.EXACT);
  });

  it('two posters under one name → INDETERMINATE, not a silent pick', () => {
    const both = [
      { name: 'CodeRifts / contract-gate', conclusion: 'success', app: { slug: 'some-other-app', id: 99 } },
      { name: 'CodeRifts / contract-gate', conclusion: 'failure', app: { slug: 'coderifts', id: 2860592 } },
    ];
    const r = analyzeReadback({ protection: PROTECTION, checkRuns: both });
    assert.equal(r.required[0].status, READBACK.INDETERMINATE);
    assert.equal(r.required[0].posters.length, 2);
  });

  it('nobody posted it → ABSENT, distinct from INDETERMINATE', () => {
    const r = analyzeReadback({ protection: PROTECTION, checkRuns: [] });
    assert.equal(r.required[0].status, READBACK.ABSENT);
    assert.equal(r.required[0].green, false);
  });

  it('a source-bound requirement reports the binding', () => {
    const bound = {
      ...PROTECTION,
      required_status_checks: { strict: true, checks: [{ context: 'CodeRifts / contract-gate', app_id: 2860592 }] },
    };
    const r = analyzeReadback({ protection: bound, checkRuns: CHECK_RUNS });
    assert.equal(r.required[0].bound_to_source, true);
    assert.equal(r.required[0].bound_app_id, 2860592);
    assert.deepEqual(r.name_only_contexts, []);
    assert.equal(r.strict_up_to_date, true);
  });

  it('falls back to contexts[] when checks[] is absent (older protection payloads)', () => {
    const old = { required_status_checks: { strict: false, contexts: ['CodeRifts / contract-gate'] }, enforce_admins: { enabled: true } };
    const r = analyzeReadback({ protection: old, checkRuns: CHECK_RUNS });
    assert.equal(r.required[0].bound_to_source, false);
    assert.equal(r.enforce_admins, true);
  });

  it('an unprotected branch reports no required checks rather than throwing', () => {
    const r = analyzeReadback({ protection: {}, checkRuns: CHECK_RUNS });
    assert.deepEqual(r.required, []);
    assert.ok(render(r).includes('no required status checks'));
  });
});

describe('readback — the rendering names the gap in words', () => {
  it('says NO — name-only match for an unbound context', () => {
    const text = render(analyzeReadback({ protection: PROTECTION, checkRuns: CHECK_RUNS }));
    assert.match(text, /source-bound:\s+NO — name-only match/);
    assert.match(text, /posted by:\s+coderifts \(app_id 2860592\)/);
    assert.match(text, /Name-only contexts can be satisfied by any poster/);
  });
});
