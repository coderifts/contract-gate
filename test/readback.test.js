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

/**
 * 1329 — the rulesets source.
 *
 * MEASURED live on coderifts/demo 2026-09-03, and the measurement is why this exists: the producer
 * read branch protection and check-runs and never called /rulesets, so it could not see the binding
 * that actually gates main —
 *
 *   ruleset 22074842 "coderifts-enforcement", enforcement: active, bypass_actors: []
 *     required_status_checks: [{ context: "CodeRifts / contract-gate (Action)", integration_id: 15368 }]
 *
 * while every check-run on every PR head was posted by app 2860592 (`coderifts`) under the name
 * "CodeRifts / contract-gate" — a DIFFERENT name and a DIFFERENT issuer. Nothing produces the
 * required context at all.
 */
describe('1329 — rulesets are read, and UNREADABLE is not ABSENT', () => {
  const {
    analyzeRulesets, crossCheckRulesets, RULESETS, analyzeReadback, buildResult,
  } = require('../scripts/readback');
  // The sibling describe compiles its own validator in its own scope; this block needs one too.
  const Ajv = require('/Users/zsobrakpeter/coderifts-app/node_modules/ajv/dist/2020');
  const schema = require('../docs/provider-enforcement-result.v1.json');
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

  /** The live shape, verbatim from the API on 2026-09-03. */
  const LIVE_RULESET = {
    id: 22074842,
    name: 'coderifts-enforcement',
    enforcement: 'active',
    bypass_actors: [],
    rules: [{
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [
          { context: 'CodeRifts / contract-gate (Action)', integration_id: 15368 },
        ],
      },
    }],
  };

  it('null means UNREADABLE with a reason — never "no rulesets"', () => {
    // The distinction the whole file turns on. A token without the permission would otherwise
    // report a repository with an active blocking ruleset as unbound.
    const r = analyzeRulesets(null);
    assert.equal(r.status, RULESETS.UNREADABLE);
    assert.notEqual(r.status, RULESETS.ABSENT);
    assert.match(r.reason, /NOT evidence that no ruleset/);
    assert.deepEqual(r.requirements, []);
  });

  it('an empty list IS absence — it was read and nothing was there', () => {
    const r = analyzeRulesets([]);
    assert.equal(r.status, RULESETS.ABSENT);
    assert.equal(r.reason, null);
  });

  it('the live ruleset reads as BOUND, and carries the integration_id', () => {
    const r = analyzeRulesets([LIVE_RULESET]);
    assert.equal(r.status, RULESETS.BOUND);
    assert.equal(r.requirements.length, 1);
    const req = r.requirements[0];
    assert.equal(req.context, 'CodeRifts / contract-gate (Action)');
    assert.equal(req.integration_id, 15368);
    assert.equal(req.active, true);
    assert.equal(req.bypass_actor_count, 0);
    assert.equal(req.ruleset_id, 22074842);
  });

  it('a requirement with no integration_id is NAME_ONLY — anyone can satisfy it', () => {
    const nameOnly = JSON.parse(JSON.stringify(LIVE_RULESET));
    delete nameOnly.rules[0].parameters.required_status_checks[0].integration_id;
    assert.equal(analyzeRulesets([nameOnly]).status, RULESETS.NAME_ONLY);
  });

  it('an inactive ruleset does not make the repository BOUND', () => {
    // `evaluate` mode gates nothing. Counting it would report enforcement that is not happening.
    const evaluating = { ...LIVE_RULESET, enforcement: 'evaluate' };
    const r = analyzeRulesets([evaluating]);
    assert.equal(r.status, RULESETS.ABSENT);
    assert.equal(r.requirements.length, 1, 'the row is still recorded, just not counted');
    assert.equal(r.requirements[0].active, false);
  });

  describe('cross-check against who actually posted', () => {
    it('THE LIVE STATE: nothing posts the required context', () => {
      // Not POSTED_BY_OTHER_ISSUER — nobody posted that NAME at all. A required context nothing
      // produces is a permanently-pending gate, which looks like enforcement and is not.
      const rows = crossCheckRulesets(analyzeRulesets([LIVE_RULESET]), [
        { name: 'CodeRifts / contract-gate', conclusion: 'success', app: { id: 2860592, slug: 'coderifts' } },
      ]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].agreement, 'NOTHING_POSTED_THIS_CONTEXT');
      assert.equal(rows[0].posted_count, 0);
    });

    it('the bound issuer posting it is BOUND_ISSUER_POSTED', () => {
      const rows = crossCheckRulesets(analyzeRulesets([LIVE_RULESET]), [
        { name: 'CodeRifts / contract-gate (Action)', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } },
      ]);
      assert.equal(rows[0].agreement, 'BOUND_ISSUER_POSTED');
    });

    it('the RIGHT NAME from the WRONG issuer is POSTED_BY_OTHER_ISSUER', () => {
      // This is the auditor's sharper negative test, as a unit: the ruleset binds 15368, and a
      // different app posts the same context. It must not read as satisfied.
      const rows = crossCheckRulesets(analyzeRulesets([LIVE_RULESET]), [
        { name: 'CodeRifts / contract-gate (Action)', conclusion: 'success', app: { id: 2860592, slug: 'coderifts' } },
      ]);
      assert.equal(rows[0].agreement, 'POSTED_BY_OTHER_ISSUER');
      assert.deepEqual(rows[0].poster_app_ids, [2860592]);
    });
  });

  it('the result document carries the binding, with UNREADABLE as a real value', () => {
    const analysis = analyzeReadback({
      protection: { required_status_checks: { checks: [{ context: 'x', app_id: 1 }] } },
      checkRuns: [],
      rulesets: [LIVE_RULESET],
    });
    const doc = buildResult(analysis, {});
    assert.equal(doc.ruleset_binding.status, 'BOUND');
    assert.equal(doc.ruleset_binding.requirements[0].integration_id, 15368);
    assert.equal(doc.ruleset_binding.cross_check[0].agreement, 'NOTHING_POSTED_THIS_CONTEXT');
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));

    // Omitting the argument is not the same as reading nothing: older callers get UNREADABLE with
    // a reason that says so, never a false ABSENT.
    const legacy = buildResult(analyzeReadback({
      protection: { required_status_checks: { checks: [] } }, checkRuns: [],
    }), {});
    assert.equal(legacy.ruleset_binding.status, 'UNREADABLE');
    assert.match(legacy.ruleset_binding.reason, /did not request/);
  });

  it('a 403 on /rulesets fails SOFT to UNREADABLE, never to an empty list', async () => {
    // The most likely field case: the token can read protection and check-runs but not rulesets.
    // Turning that into `[]` would report a repository with an active blocking ruleset as having
    // none — the failure this whole module exists to prevent, arriving through the I/O layer.
    const { fetchReadback } = require('../scripts/readback');
    const json = (body) => ({ status: 200, json: async () => body });
    const fetchImpl = async (url) => {
      if (url.includes('/pulls/')) return json({ head: { sha: 'abc' }, base: { ref: 'main' } });
      if (url.includes('/protection')) return json({ required_status_checks: { checks: [] } });
      if (url.includes('/check-runs')) return json({ check_runs: [] });
      if (url.includes('/rulesets')) return { status: 403, json: async () => ({}) };
      throw new Error(`unexpected ${url}`);
    };
    const out = await fetchReadback({
      owner: 'o', repo: 'r', pr: 1, token: 't', expectApp: null, fetchImpl,
    });
    assert.equal(out.rulesets.status, RULESETS.UNREADABLE);
    assert.notEqual(out.rulesets.status, RULESETS.ABSENT);
    assert.match(out.rulesets.reason, /NOT evidence/);
  });

  it('a ruleset that cannot be EXPANDED also fails soft — a partial list is not a list', async () => {
    // The list endpoint returns summaries without `rules`. If expansion fails halfway, the rules
    // we did read would under-report the binding while looking complete.
    const { fetchReadback } = require('../scripts/readback');
    const json = (body) => ({ status: 200, json: async () => body });
    const fetchImpl = async (url) => {
      if (url.includes('/pulls/')) return json({ head: { sha: 'abc' }, base: { ref: 'main' } });
      if (url.includes('/protection')) return json({ required_status_checks: { checks: [] } });
      if (url.includes('/check-runs')) return json({ check_runs: [] });
      if (/\/rulesets\/\d+$/.test(url)) return { status: 404, json: async () => ({}) };
      if (url.endsWith('/rulesets')) return json([{ id: 22074842 }]);
      throw new Error(`unexpected ${url}`);
    };
    const out = await fetchReadback({
      owner: 'o', repo: 'r', pr: 1, token: 't', expectApp: null, fetchImpl,
    });
    assert.equal(out.rulesets.status, RULESETS.UNREADABLE);
  });

  it('the schema no longer claims nothing produces this', () => {
    const schema = require('../docs/provider-enforcement-result.v1.json');
    assert.equal(/nothing produces or consumes this/.test(schema.description), false);
    assert.match(schema.description, /PRODUCER: scripts\/readback\.js --result/);
    assert.match(schema.description, /UNION of branch protection and any/);
  });
});
