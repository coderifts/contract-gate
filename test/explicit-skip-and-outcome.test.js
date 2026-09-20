'use strict';

/**
 * C.7 #11 and #12, and the namespace that keeps their codes apart from the deny reasons.
 *
 * #11  A skip asked for in words is REFUSED, on all three carriers, as a FAILURE.
 * #12  What counts as a contract change is decided from the real git diff INSIDE the job,
 *      so nothing upstream of the job can turn a governed change into a silent pass.
 *
 * Every positive case here has a negative twin. A test that only ever sees the marker present
 * cannot tell a working detector from one that returns true.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { OUTCOME_CODE, OUTCOME_CONCLUSION, assertDisjoint } = require('../src/outcome-code');
const { DENY_ERROR } = require('../src/deny-remedy');
const { detectExplicitSkip } = require('../src/explicit-skip');

const SPEC = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';

/**
 * A real repo, because the commit-message carrier is read with real git. `headMessage` is the
 * knob these tests turn.
 */
function makeRepo({ headMessage = 'head', contractChange = true, filePath = 'api/openapi.yaml' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skip-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, path.dirname(filePath)), { recursive: true });
  fs.writeFileSync(path.join(dir, filePath), SPEC);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  if (contractChange) {
    fs.writeFileSync(path.join(dir, filePath), SPEC + '  /health:\n    get: { responses: { "200": { description: ok } } }\n');
  } else {
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\nchanged\n');
  }
  g('add', '-A'); g('commit', '-q', '-m', headMessage);
  return { dir, baseSha, headSha: g('rev-parse', 'HEAD').trim() };
}

function capture() {
  const seen = { check: null, preflightCalls: 0 };
  return {
    seen,
    postCheckRunImpl: async (o) => { seen.check = o; return { id: 1 }; },
    // If this ever runs on a refused-skip path, the gate spent a network call and an API key on a
    // run whose only possible outcome was refusal. Counting is the only way to notice.
    preflightImpl: async () => { seen.preflightCalls += 1; throw new Error('preflight must not be reached'); },
  };
}

const base = (r, c, extra = {}) => ({
  apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
  baseSha: r.baseSha, headSha: r.headSha, cwd: r.dir,
  postCheckRunImpl: c.postCheckRunImpl, preflightImpl: c.preflightImpl, log: () => {},
  prTitle: '', env: {}, ...extra,
});

// ── C.7 #11 — the refusal, on each carrier in turn ──────────────────────────────────────────
for (const [carrier, extra, repoOpts] of [
  ['pr_title',           { prTitle: 'fix: bump dep [skip coderifts]' }, {}],
  ['commit_message',     {},                                           { headMessage: 'wip\n\n[skip coderifts]' }],
  ['env_CODERIFTS_SKIP', { env: { CODERIFTS_SKIP: '1' } },             {}],
]) {
  test(`#11 explicit skip via ${carrier} => FAILURE, EXPLICIT_SKIP_NOT_ALLOWED`, async () => {
    const r = makeRepo(repoOpts); const c = capture();
    const res = await runGate(base(r, c, extra));

    assert.equal(res.exitCode, 1, 'a refused skip must fail the job');
    assert.equal(res.outcomeCode, OUTCOME_CODE.EXPLICIT_SKIP_NOT_ALLOWED);
    assert.deepEqual(res.skipSources, [carrier]);
    // FAILURE, not neutral: a neutral conclusion leaves the pull request mergeable, which is the
    // exact outcome the person writing the marker was after.
    assert.equal(c.seen.check.conclusion, 'failure');
    assert.notEqual(c.seen.check.conclusion, 'neutral');
    // Refused before any key was spent.
    assert.equal(c.seen.preflightCalls, 0);
  });
}

test('#11 all three carriers at once are ALL named, not just the first', async () => {
  const r = makeRepo({ headMessage: 'wip\n\n[skip coderifts]' }); const c = capture();
  const res = await runGate(base(r, c, {
    prTitle: '[skip coderifts] rush', env: { CODERIFTS_SKIP: 'yes' },
  }));
  assert.deepEqual(res.skipSources, ['pr_title', 'commit_message', 'env_CODERIFTS_SKIP']);
});

test('#11 the refusal does not depend on anything having changed', async () => {
  // A skip request on a diff with no contract change is still a request to not be checked.
  const r = makeRepo({ contractChange: false }); const c = capture();
  const res = await runGate(base(r, c, { prTitle: '[skip coderifts]' }));
  assert.equal(res.outcomeCode, OUTCOME_CODE.EXPLICIT_SKIP_NOT_ALLOWED);
  assert.equal(res.exitCode, 1);
});

// ── NEGATIVE CONTROLS for #11 ───────────────────────────────────────────────────────────────
test('#11 NEGATIVE — an ordinary PR is not read as a skip request', async () => {
  const r = makeRepo({ contractChange: false }); const c = capture();
  const res = await runGate(base(r, c, { prTitle: 'fix: bump dependency' }));
  assert.notEqual(res.outcomeCode, OUTCOME_CODE.EXPLICIT_SKIP_NOT_ALLOWED);
  assert.equal(res.exitCode, 0);
});

test('#11 NEGATIVE — CODERIFTS_SKIP set to an OFF value is not a request', () => {
  for (const off of ['', 'false', '0', 'no', 'off', 'FALSE']) {
    assert.equal(detectExplicitSkip({ env: { CODERIFTS_SKIP: off } }).requested, false, `off value: ${off}`);
  }
  // ...and the affirmative side still fires, so the OFF list is not swallowing everything.
  assert.equal(detectExplicitSkip({ env: { CODERIFTS_SKIP: 'true' } }).requested, true);
});

test('#11 NEGATIVE — prose ABOUT the marker is not the marker', () => {
  const near = [
    'docs: explain why [skip ci] is not honoured here',
    'refactor: rename skipCoderifts helper',
    'chore: remove the skip coderifts paragraph',   // no brackets
  ];
  for (const m of near) assert.equal(detectExplicitSkip({ prTitle: m }).requested, false, m);
  // Spelling variants that ARE the marker still fire — the detector is narrow, not blind.
  for (const m of ['[skip coderifts]', '[SKIP_CODERIFTS]', '[ skip-coderifts ]']) {
    assert.equal(detectExplicitSkip({ prTitle: m }).requested, true, m);
  }
});

// ── C.7 #12 — the contract decision is made INSIDE the job, from the real diff ───────────────
test('#12 a non-contract diff concludes NO_CONTRACT_CHANGE — a reached conclusion, not silence', async () => {
  const r = makeRepo({ contractChange: false }); const c = capture();
  const res = await runGate(base(r, c));
  assert.equal(res.exitCode, 0);
  assert.equal(res.outcomeCode, OUTCOME_CODE.NO_CONTRACT_CHANGE);
  assert.equal(c.seen.check.conclusion, 'success');
  // The check was POSTED. That is the difference between "looked and found nothing" and a job
  // that never ran: the second reports nothing, and GitHub reads nothing as not-failing.
  assert.ok(c.seen.check.summary.includes(OUTCOME_CODE.NO_CONTRACT_CHANGE));
});

test('#12 a contract change in an unusual directory is still governed', async () => {
  // If anything upstream could decide "this directory is not interesting", a contract living
  // somewhere unexpected would sail through. The gate derives from the diff, so it does not.
  //
  // ⚠ MEASURED while writing this: `tools/vendor/spec/openapi.yaml` does NOT reach preflight,
  // and that is correct — contract-path.js excludes any path containing `vendor/` or
  // `node_modules/` on purpose. My first version of this test picked that path and failed; the
  // test was wrong, not the gate. The exclusion is pinned separately below so it stays a
  // decision rather than an accident.
  const r = makeRepo({ contractChange: true, filePath: 'tools/spec/openapi.yaml' });
  const c = capture();
  // ⚠ runGate CATCHES a throwing preflight and turns it into a failure result rather than
  // propagating, so the observable is the call count, not a rejection. (My first version
  // asserted a rejection and failed for that reason — the gate was right, the assertion wasn't.)
  const res = await runGate(base(r, c));
  assert.equal(c.seen.preflightCalls, 1, 'the gate treated the change as governed');
  assert.notEqual(res.outcomeCode, OUTCOME_CODE.NO_CONTRACT_CHANGE,
    'a real contract change must never conclude NO_CONTRACT_CHANGE');
});

// ── the namespace ───────────────────────────────────────────────────────────────────────────
test('outcome codes are disjoint from the published deny-reason enum', () => {
  assert.equal(assertDisjoint(DENY_ERROR), true);
  // And the guard is not vacuous: a colliding value must throw.
  assert.throws(() => assertDisjoint({ ...DENY_ERROR, X: OUTCOME_CODE.NO_CONTRACT_CHANGE }),
    /appears in BOTH/);
});

test('every outcome code maps to a conclusion, and the two failures do not agree', () => {
  for (const code of Object.values(OUTCOME_CODE)) {
    assert.ok(OUTCOME_CONCLUSION[code], `${code} has no conclusion`);
  }
  assert.equal(OUTCOME_CONCLUSION[OUTCOME_CODE.NO_CONTRACT_CHANGE], 'success');
  assert.equal(OUTCOME_CONCLUSION[OUTCOME_CODE.EXPLICIT_SKIP_NOT_ALLOWED], 'failure');
});

test('#12 the vendor/ and node_modules/ exclusions are deliberate, and narrow', () => {
  const { looksLikeContractPath } = require('../src/contract-path');
  // Excluded: a vendored copy is someone else's contract, and governing it would fail PRs for
  // changes the repo did not author.
  assert.equal(looksLikeContractPath('tools/vendor/spec/openapi.yaml'), false);
  assert.equal(looksLikeContractPath('node_modules/x/openapi.yaml'), false);
  // NOT excluded: the same file one directory over. The rule is a path segment, not a guess
  // about the word "spec" or about depth.
  assert.equal(looksLikeContractPath('tools/spec/openapi.yaml'), true);
  assert.equal(looksLikeContractPath('a/b/c/d/e/openapi.yaml'), true);
  // And a word that merely CONTAINS vendor is not the segment.
  assert.equal(looksLikeContractPath('vendors-api/openapi.yaml'), true);
});

// ── X.21 — the merge-queue event shape ──────────────────────────────────────────────────────
test('readEvent understands merge_group, and still refuses events that are neither', () => {
  const { readEvent } = require('../src/index');
  const os2 = require('node:os');
  const write = (name, obj) => {
    const f = path.join(fs.mkdtempSync(path.join(os2.tmpdir(), 'cg-ev-')), name);
    fs.writeFileSync(f, JSON.stringify(obj)); return f;
  };
  const A = 'a'.repeat(40); const B = 'b'.repeat(40);

  const mg = readEvent(write('mg.json', {
    repository: { full_name: 'o/r' }, merge_group: { base_sha: B, head_sha: A },
  }));
  assert.equal(mg.eventKind, 'merge_group');
  assert.equal(mg.baseSha, B);
  assert.equal(mg.headSha, A);
  // There is no pull request on the queue path, so there is no title. Empty, not undefined,
  // and empty is not a skip request.
  assert.equal(mg.prTitle, '');
  assert.equal(detectExplicitSkip({ prTitle: mg.prTitle }).requested, false);

  const pr = readEvent(write('pr.json', {
    repository: { full_name: 'o/r' },
    pull_request: { title: 'feat: x', base: { sha: B }, head: { sha: A } },
  }));
  assert.equal(pr.eventKind, 'pull_request');
  assert.equal(pr.prTitle, 'feat: x');

  // NEGATIVE: the widening is to exactly two shapes, not to "whatever arrives".
  assert.throws(() => readEvent(write('push.json', { repository: { full_name: 'o/r' }, pusher: {} })),
    /neither a pull_request nor a merge_group/);
});

test('the commit-message carrier survives on the queue path, which is why it matters', async () => {
  // On merge_group there is no PR title. If the marker only ever travelled in the title, the
  // queue would be the way around the refusal. It travels with the commits instead.
  const r = makeRepo({ headMessage: 'feat: x\n\n[skip coderifts]' }); const c = capture();
  const res = await runGate(base(r, c, { prTitle: '' }));
  assert.equal(res.outcomeCode, OUTCOME_CODE.EXPLICIT_SKIP_NOT_ALLOWED);
  assert.deepEqual(res.skipSources, ['commit_message']);
});
