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

// ── 1262 — the PRODUCER ──────────────────────────────────────────────────────
//
// provider-enforcement-result.v1 had a schema and a hand-written example and no producer, so the
// one document that states what a provider enforces was the one nobody measured. These tests run
// the real construction over a rollup fixture — the same pure path `--result` uses.
describe('buildResult — provider-enforcement-result.v1 from a live readback', () => {
  const { buildResult, NEGATIVE_TEST } = require('../scripts/readback.js');
  const Ajv = require('/Users/zsobrakpeter/coderifts-app/node_modules/ajv/dist/2020');
  const schema = require('../docs/provider-enforcement-result.v1.json');
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

  const boundRollup = () => analyzeReadback({
    protection: {
      enforce_admins: { enabled: true },
      required_status_checks: {
        strict: false,
        checks: [{ context: 'CodeRifts / contract-gate', app_id: 15368 }],
      },
    },
    checkRuns: [{
      name: 'CodeRifts / contract-gate',
      conclusion: 'success',
      app: { slug: 'coderifts', id: 15368 },
    }],
    expectApp: 'coderifts',
  });

  it('a BOUND, EXACT rollup produces a schema-valid app-mode document', () => {
    const doc = buildResult(boundRollup(), { expectApp: 'coderifts' });
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.equal(doc.provider, 'github');
    assert.equal(doc.mode, 'app');
    assert.equal(doc.required_check.bound_to_source, true);
    assert.equal(doc.required_check.bound_app_id, 15368);
    assert.equal(doc.readback.status, 'EXACT');
    assert.equal(doc.bypass_policy.enforce_admins, true);
    // The poster must be comparable with the binding — that is the question the doc answers.
    assert.equal(doc.required_check.posters[0].app_id, doc.required_check.bound_app_id);
  });

  it('a NAME-ONLY requirement is reported as mode none, and the statement says why', () => {
    const analysis = analyzeReadback({
      protection: {
        enforce_admins: { enabled: false },
        required_status_checks: { strict: false, contexts: ['CodeRifts / contract-gate'] },
      },
      checkRuns: [{ name: 'CodeRifts / contract-gate', conclusion: 'success', app: { slug: 'x', id: 1 } }],
    });
    const doc = buildResult(analysis);
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.equal(doc.mode, 'none', 'a name-only requirement is not app-bound enforcement');
    assert.equal(doc.required_check.bound_app_id, null);
    assert.match(doc.statement, /name-only/);
    assert.match(doc.statement, /enforce_admins is OFF/);
  });

  it('NO required check at all → mode none, readback ABSENT, and it says the door is open', () => {
    const doc = buildResult(analyzeReadback({
      protection: { enforce_admins: { enabled: false }, required_status_checks: null },
      checkRuns: [],
    }));
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.equal(doc.mode, 'none');
    assert.equal(doc.readback.status, 'ABSENT');
    assert.match(doc.statement, /nothing at the provider prevents a merge/);
  });

  it('TWO posters → INDETERMINATE, never EXACT', () => {
    const doc = buildResult(analyzeReadback({
      protection: {
        enforce_admins: { enabled: true },
        required_status_checks: { strict: false, checks: [{ context: 'c', app_id: 7 }] },
      },
      checkRuns: [
        { name: 'c', conclusion: 'success', app: { slug: 'a', id: 7 } },
        { name: 'c', conclusion: 'success', app: { slug: 'b', id: 9 } },
      ],
    }));
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.equal(doc.readback.status, 'INDETERMINATE');
    assert.match(doc.statement, /not EXACT/);
  });

  it('the negative test is CARRIED and DATED — never silently claimed', () => {
    const doc = buildResult(boundRollup(), { expectApp: 'coderifts' });
    assert.equal(doc.negative_test.status, 'PASSED');
    assert.equal(doc.negative_test.observed_at, NEGATIVE_TEST.observed_at);
    assert.match(doc.negative_test.observed_at, /^\d{4}-\d{2}-\d{2}T/, 'RFC 3339 date-time');
    // It must say it was recorded rather than re-run — a producer that silently emitted PASSED
    // for a destructive test it never performed is the failure this schema exists to prevent.
    assert.match(doc.negative_test.procedure, /Recorded rather than re-run/);
    assert.match(doc.negative_test.procedure, /403/);
    assert.match(doc.negative_test.procedure, /BLOCKED/);
  });

  it('the committed demo document is exactly what the producer emits, and validates', () => {
    const demo = require('../docs/provider-enforcement-result.demo.json');
    assert.equal(validate(demo), true, JSON.stringify(validate.errors));
    assert.deepEqual(demo, buildResult(boundRollup(), { expectApp: 'coderifts' }));
  });

  it('GitLab / Bitbucket are NAMED as unimplemented, not left to inference', () => {
    const doc = buildResult(boundRollup(), { expectApp: 'coderifts' });
    assert.match(doc.not_implemented, /GitLab and Bitbucket/);
    assert.match(doc.not_implemented, /NOT_VERIFIED/);
  });
});
