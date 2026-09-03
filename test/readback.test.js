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

  it('NO required check AND rulesets READ AND EMPTY → the door really is open', () => {
    // 1338: "open door" is now a claim about the UNION, so it requires having LOOKED at the second
    // source. `rulesets: []` is that look, and it found nothing.
    const doc = buildResult(analyzeReadback({
      protection: { enforce_admins: { enabled: false }, required_status_checks: null },
      checkRuns: [],
      rulesets: [],
    }));
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.equal(doc.mode, 'none');
    assert.equal(doc.readback.status, 'ABSENT');
    assert.match(doc.statement, /nothing at the provider prevents a merge/);
    assert.match(doc.statement, /no active ruleset requires one/);
  });

  it('NO required check and rulesets NOT READ → UNDECIDED, not an open door', () => {
    // The caller did not ask for rulesets. Not having looked is not the same as having looked and
    // found nothing, and this producer used to report the stronger of the two.
    const doc = buildResult(analyzeReadback({
      protection: { enforce_admins: { enabled: false }, required_status_checks: null },
      checkRuns: [],
    }));
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.match(doc.statement, /UNDECIDED/);
    assert.doesNotMatch(doc.statement, /beside an open door/,
      'an unread rulesets API was reported as an open door');
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

/**
 * 1334 — the Action must be able to post NOTHING where the App already posts the required check.
 *
 * MEASURED on coderifts/demo PR#4 (2026-09-03): three contract-gate check-runs on one head, two of
 * them from the generic Actions issuer. Dropping the `check-name` override does not fix it — the
 * default name is the same string the App posts, so the Action would post a same-named check under
 * a different issuer, which is the INDETERMINATE case this repo's readback exists to name.
 */
describe('1334 — post-check-run opt-out', () => {
  const { runGate } = require('../src/index');

  const baseArgs = () => {
    const posted = [];
    return {
      posted,
      args: {
        apiKey: 'k', apiUrl: 'https://example.invalid', githubToken: 't',
        owner: 'o', repo: 'r', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), cwd: process.cwd(),
        postCheckRunImpl: async (o) => { posted.push(o); return { ok: true, status: 201 }; },
        fetchImpl: async () => { throw new Error('no network in this test'); },
        log: () => {},
      },
    };
  };

  it('posts by default — existing consumers are unchanged', async () => {
    const { posted, args } = baseArgs();
    await runGate(args).catch(() => {});
    assert.ok(posted.length > 0, 'the default must keep posting the check');
  });

  it('postCheckRun:false posts NOTHING, even on the failure path', async () => {
    const { posted, args } = baseArgs();
    await runGate({ ...args, postCheckRun: false }).catch(() => {});
    assert.deepEqual(posted, [], 'a competing check-run was posted despite the opt-out');
  });

  it('only the exact string "false" disables it — a typo must not remove the check', () => {
    // Same bar as MERGEGATE_ENFORCE in the app: one unambiguous value, because the failure mode of
    // a typo here is a gate that silently stops producing its own evidence.
    //
    // Asserted against the SOURCE, not against a copy of the expression. The first version of this
    // test re-implemented the check inline and passed while the real one was replaced with
    // `!process.env[...]` — a test that graded its own restatement.
    const fs2 = require('node:fs');
    const src = fs2.readFileSync(require('node:path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const m = /postCheckRun:\s*(.+),\n/.exec(src.slice(src.indexOf("INPUT_POST-CHECK-RUN") - 200));
    assert.ok(m, 'could not locate the env read for post-check-run');
    const expr = m[1];
    assert.match(expr, /toLowerCase\(\)\s*!==\s*'false'/,
      `the env read is \`${expr}\` — it must compare against the exact string 'false', so that '0', `
      + "'no' and '' keep the check posting");
  });

  it('action.yml documents WHY, not just that it exists', () => {
    const fs2 = require('node:fs');
    const yml = fs2.readFileSync(require('node:path').join(__dirname, '..', 'action.yml'), 'utf8');
    assert.match(yml, /post-check-run:/);
    assert.match(yml, /generic GitHub Actions identity/);
    assert.match(yml, /cannot tell which one satisfied/);
  });
});

/**
 * 1329 — classic branch protection may be ABSENT, and that is a configuration, not a failure.
 *
 * MEASURED live on coderifts/demo 2026-09-03: after the requirement moved into the ruleset and
 * classic protection was deleted, `GET /branches/main/protection` returns 404 "Branch not
 * protected". The producer threw on it and emitted NOTHING for a repository whose ruleset is
 * active, bound to 2860592, and gating — the modern configuration was the one it could not read.
 */
describe('1329 — a 404 on classic protection is absence, other statuses are not', () => {
  const { fetchReadback } = require('../scripts/readback');
  const json = (body) => ({ status: 200, json: async () => body });

  const base = (protectionResponse) => async (url) => {
    if (url.includes('/pulls/')) return json({ head: { sha: 'abc' }, base: { ref: 'main' } });
    if (url.includes('/protection')) return protectionResponse;
    if (url.includes('/check-runs')) {
      return json({ check_runs: [{ name: 'CodeRifts / contract-gate', conclusion: 'success', app: { id: 2860592, slug: 'coderifts' } }] });
    }
    if (/\/rulesets\/\d+$/.test(url)) {
      return json({
        id: 22074842, name: 'coderifts-enforcement', enforcement: 'active', bypass_actors: [],
        rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CodeRifts / contract-gate', integration_id: 2860592 }] } }],
      });
    }
    if (url.endsWith('/rulesets')) return json([{ id: 22074842 }]);
    throw new Error(`unexpected ${url}`);
  };

  it('404 → the run completes and the RULESET binding is still reported', async () => {
    const out = await fetchReadback({
      owner: 'o', repo: 'r', pr: 1, token: 't', expectApp: 'coderifts',
      fetchImpl: base({ status: 404, json: async () => ({ message: 'Branch not protected' }) }),
    });
    assert.equal(out.rulesets.status, 'BOUND', 'the modern configuration must still be read');
    assert.equal(out.ruleset_cross_check[0].agreement, 'BOUND_ISSUER_POSTED');
    // Classic protection genuinely absent: no requirement rows, and that is not an error.
    assert.deepEqual(out.required, []);
  });

  it('403 STILL throws — "could not look" is not "nothing is there"', async () => {
    // The absence-vs-unreadable line. Swallowing a 403 here would report a protected branch as
    // unprotected, which is the collapse this module refuses everywhere else.
    await assert.rejects(
      fetchReadback({
        owner: 'o', repo: 'r', pr: 1, token: 't', expectApp: null,
        fetchImpl: base({ status: 403, json: async () => ({}) }),
      }),
      /HTTP 403/,
    );
  });
});

/**
 * 1338 — the producer contradicted itself, measured live on coderifts/demo (2026-09-03).
 *
 * After classic branch protection was deleted, one document said both of these at once:
 *
 *   readback.status : ABSENT
 *   statement       : "nothing at the provider prevents a merge … beside an open door"
 *   ruleset_binding : BOUND, integration_id 2860592, BOUND_ISSUER_POSTED
 *
 * The cause was a source mismatch, not a logic error: `statement` and `readback` read classic
 * `branches/main/protection` only, while enforcement had moved to a RULESET. The schema's own
 * description already stated the rule — "a repository's rules are the UNION of branch protection
 * and any active rulesets" — and the producer did not follow it.
 *
 * THE WORST CASE these tests are written against: an operator reads "open door", adds a second
 * requirement or panics about an unprotected branch, when the branch was gated the whole time.
 * The opposite mistake is just as bad, so the last group holds that line too.
 */
describe('1338 — statement and readback read the UNION, not classic protection alone', () => {
  // Same imports the 1262 block uses: buildResult and the schema validator are scoped to their
  // describe, not to the module.
  const { buildResult } = require('../scripts/readback.js');
  const Ajv = require('/Users/zsobrakpeter/coderifts-app/node_modules/ajv/dist/2020');
  const schema = require('../docs/provider-enforcement-result.v1.json');
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);

  const BOUND_RULESET = {
    id: 22074842,
    name: 'main-protection',
    enforcement: 'active',
    rules: [{
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [
          { context: 'CodeRifts / contract-gate', integration_id: 2860592 },
        ],
      },
    }],
    bypass_actors: [],
  };

  /** The live shape after the deletion: no classic protection, one binding ruleset. */
  function rulesetOnly(rulesets = [BOUND_RULESET]) {
    return buildResult(analyzeReadback({
      protection: { enforce_admins: { enabled: false }, required_status_checks: null },
      checkRuns: [
        { name: 'CodeRifts / contract-gate', conclusion: 'success', app: { slug: 'coderifts', id: 2860592 } },
      ],
      rulesets,
    }));
  }

  it('THE FINDING: a ruleset-bound repo with no classic protection is NOT an open door', () => {
    const doc = rulesetOnly();
    assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    assert.doesNotMatch(doc.statement, /beside an open door/,
      'a ruleset-gated repository was reported as unprotected');
    assert.doesNotMatch(doc.statement, /nothing at the provider prevents a merge/);
    assert.match(doc.statement, /ACTIVE RULESET requires the check/);
    assert.match(doc.statement, /does gate the merge/);
  });

  it('THE FINDING: readback.status is no longer ABSENT when a ruleset binds', () => {
    // ABSENT is a claim about the union — "nothing requires this". This block reads check runs
    // against classic contexts and has none to read, which is INDETERMINATE, not ABSENT.
    const doc = rulesetOnly();
    assert.notEqual(doc.readback.status, 'ABSENT');
    assert.equal(doc.readback.status, 'INDETERMINATE');
    assert.match(doc.readback.evidence, /no CLASSIC required status checks/);
    assert.match(doc.readback.evidence, /see ruleset_binding/);
  });

  it('the document no longer contradicts itself', () => {
    // The property that failed live: two blocks, one repository, opposite answers.
    const doc = rulesetOnly();
    assert.equal(doc.ruleset_binding.status, 'BOUND');
    assert.equal(doc.ruleset_binding.requirements[0].integration_id, 2860592);
    const saysOpen = /open door|nothing at the provider prevents a merge/.test(doc.statement);
    const saysBound = doc.ruleset_binding.status === 'BOUND';
    assert.equal(saysOpen && saysBound, false,
      'the statement says open door while ruleset_binding says BOUND');
  });

  it('a NAME-ONLY ruleset is gating, and says it can be satisfied by anyone', () => {
    // Gating is not the same as unforgeable. Reporting "does gate the merge" without this would
    // be the overclaim in the other direction.
    const nameOnly = {
      ...BOUND_RULESET,
      rules: [{
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'CodeRifts / contract-gate' }] },
      }],
    };
    const doc = rulesetOnly([nameOnly]);
    assert.match(doc.statement, /does gate the merge/);
    assert.match(doc.statement, /NAME-ONLY/);
  });

  it('an INACTIVE ruleset does not rescue a missing classic requirement', () => {
    // `evaluate` and `disabled` rulesets are recorded, never counted. If they counted, an operator
    // could believe a dry-run ruleset was protecting them.
    const doc = rulesetOnly([{ ...BOUND_RULESET, enforcement: 'evaluate' }]);
    assert.match(doc.statement, /beside an open door/,
      'a non-enforcing ruleset was treated as gating');
    assert.equal(doc.readback.status, 'ABSENT');
  });

  it('WORST CASE both ways: enforce_admins is not claimed for a ruleset-only repo', () => {
    // enforce_admins is a classic-protection field. Reporting it as ON or OFF for a repository
    // that has no classic protection would be describing a control that is not in play.
    const doc = rulesetOnly();
    assert.doesNotMatch(doc.statement, /enforce_admins is (ON|OFF)/);
    assert.match(doc.statement, /classic-protection field/);
  });

  it('the statement stays inside the schema limit on EVERY branch', () => {
    // 1338 added a fourth sentence to the both-sources branch and pushed it to 416/400 on the
    // first draft. This holds the limit so a future edit cannot overflow it silently.
    const cases = [
      rulesetOnly(),
      rulesetOnly([{ ...BOUND_RULESET, enforcement: 'evaluate' }]),
      buildResult(analyzeReadback({
        protection: {
          enforce_admins: { enabled: false },
          required_status_checks: { checks: [{ context: 'CodeRifts / contract-gate', app_id: 2860592 }] },
        },
        checkRuns: [],
        rulesets: [BOUND_RULESET],
      })),
      buildResult(analyzeReadback({
        protection: { enforce_admins: { enabled: false }, required_status_checks: null },
        checkRuns: [],
      })),
    ];
    for (const doc of cases) {
      assert.ok(doc.statement.length <= 400,
        `statement is ${doc.statement.length} chars (limit 400): ${doc.statement.slice(0, 80)}…`);
      assert.equal(validate(doc), true, JSON.stringify(validate.errors));
    }
  });
});

describe('1338 — mode reads the union too (the third place)', () => {
  const { buildResult } = require('../scripts/readback.js');
  const RS = (integration_id) => ([{
    id: 22074842, name: 'coderifts-enforcement', enforcement: 'active', bypass_actors: [],
    rules: [{
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'c', ...(integration_id ? { integration_id } : {}) }] },
    }],
  }]);
  const noClassic = (rulesets) => buildResult(analyzeReadback({
    protection: { enforce_admins: { enabled: false }, required_status_checks: null },
    checkRuns: [{ name: 'c', conclusion: 'success', app: { slug: 'coderifts', id: 2860592 } }],
    rulesets,
  }));

  it('a BOUND ruleset with no classic protection is mode "app", not "none"', () => {
    // The schema defines 'none' as "nothing binds it". A ruleset naming an integration_id binds it
    // exactly the way classic protection with an app_id does, and reporting 'none' said the
    // opposite of what ruleset_binding measured two fields below.
    assert.equal(noClassic(RS(2860592)).mode, 'app');
  });

  it('a NAME-ONLY ruleset is still mode "none" — gating is not binding', () => {
    // A requirement anyone can satisfy binds nothing to a source, whichever mechanism carries it.
    // Promoting this to 'app' would be the overclaim in the other direction.
    assert.equal(noClassic(RS(null)).mode, 'none');
  });

  it('an INACTIVE ruleset does not make it mode "app"', () => {
    const inactive = RS(2860592).map((r) => ({ ...r, enforcement: 'evaluate' }));
    assert.equal(noClassic(inactive).mode, 'none');
  });

  it('classic protection still decides when it exists', () => {
    // The union does not mean the ruleset overrides a measured classic binding.
    const doc = buildResult(analyzeReadback({
      protection: {
        enforce_admins: { enabled: false },
        required_status_checks: { checks: [{ context: 'c', app_id: null }] },
      },
      checkRuns: [{ name: 'c', conclusion: 'success', app: { slug: 'x', id: 9 } }],
      rulesets: RS(2860592),
    }));
    assert.equal(doc.mode, 'none', 'a name-only classic requirement was upgraded by the ruleset');
  });
});
