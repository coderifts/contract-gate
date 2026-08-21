'use strict';

/**
 * Covers the v2 preflight REQUEST contract the 34 existing tests never asserted:
 *   (a) preflight_mode is required (Decision Spec 2.0) — gate ENFORCES merge → authorize
 *   (b) source binding is context.head / context.base (producer ID686), not context.revision
 *
 * Existing gate-e2e mocks preflightImpl and only inspects artifacts; callPreflight's JSON
 * body is untested. Live producer (change-set.js resolvePreflightMode) 400s without
 * preflight_mode, and copies context.head (not revision) into the signed envelope.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { callPreflight, buildPreflightRequest } = require('../src/preflight');
const { runGate } = require('../src/index');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';

const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-req-'));
const keyringPath = writeKeyringFile(tmp, signer);

function makeRepo(baseSpec, headSpec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-req-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), baseSpec);
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'api/openapi.yaml'), headSpec);
  g('add', '-A'); g('commit', '-q', '-m', 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  return { dir, baseSha, headSha };
}

test('v2 request: callPreflight JSON includes preflight_mode=authorize and context.head (not revision)', async () => {
  const artifacts = [{ id: 'api/openapi.yaml', type: 'openapi', before: 'a', after: 'b' }];
  const context = {
    operation: 'merge',
    environment: 'ci',
    repository: 'acme/api',
    base: 'baseSha111',
    head: 'headSha222',
  };
  let parsed;
  const fetchImpl = async (_url, opts) => {
    parsed = JSON.parse(opts.body);
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  await callPreflight({
    apiKey: 'k',
    apiUrl: 'https://app.coderifts.com',
    artifacts,
    context,
    preflight_mode: 'authorize',
    fetchImpl,
  });
  assert.equal(parsed.preflight_mode, 'authorize', 'Decision Spec 2.0 requires preflight_mode; gate enforces merge → authorize (receipt path)');
  assert.equal(parsed.context.head, 'headSha222', 'producer copies context.head into the signed envelope (ID686)');
  assert.equal(parsed.context.base, 'baseSha111', 'producer copies context.base into the signed envelope (ID686)');
  assert.equal(parsed.context.revision, undefined, 'context.revision is not a producer source slot — would leave envelope.head unbound');
  assert.equal(parsed.context.operation, 'merge');
});

test('v2 request: runGate submits authorize + head/base SHAs (not revision) to preflight', async () => {
  const { dir, baseSha, headSha } = makeRepo(SPEC_USERS, SPEC_USERS_HEALTH);
  const captured = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: async (opts) => {
      captured.opts = opts;
      const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
      return { chain_receipt: mintV4(signer, env), decision_result: env };
    },
    postCheckRunImpl: async () => ({ ok: true, status: 201 }),
    log: () => {},
  });
  assert.equal(res.exitCode, 0);
  assert.equal(captured.opts.preflight_mode, 'authorize');
  assert.equal(captured.opts.context.head, headSha);
  assert.equal(captured.opts.context.base, baseSha);
  assert.equal(captured.opts.context.revision, undefined);
  assert.equal(captured.opts.context.repository, 'o/r');
  assert.equal(captured.opts.context.operation, 'merge');

  const body = buildPreflightRequest({
    artifacts: captured.opts.artifacts,
    context: captured.opts.context,
    preflight_mode: captured.opts.preflight_mode,
  });
  assert.equal(body.preflight_mode, 'authorize');
  assert.equal(body.context.head, headSha);
  assert.equal('revision' in body.context, false);
});
