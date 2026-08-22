'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildGateCompletenessClaim, leafPath } = require('../src/completeness-claim');
const { deriveArtifactsFromDiff } = require('../src/artifacts');
const { runGate } = require('../src/index');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const SPEC_A = 'openapi: 3.0.0\ninfo: { title: a, version: "1" }\npaths: {}\n';
const SPEC_A2 = 'openapi: 3.0.0\ninfo: { title: a, version: "2" }\npaths: {}\n';
const SPEC_B = 'openapi: 3.0.0\ninfo: { title: b, version: "1" }\npaths: {}\n';
const SPEC_B2 = 'openapi: 3.0.0\ninfo: { title: b, version: "2" }\npaths: {}\n';

test('leafPath matches app artifactPath (type:id when path absent)', () => {
  assert.equal(leafPath({ id: 'api/openapi.yaml', type: 'openapi' }), 'openapi:api/openapi.yaml');
  assert.equal(leafPath({ id: 'x', type: 'openapi', path: 'explicit' }), 'explicit');
});

test('claim leaves cover every derived artifact (N=N)', () => {
  const artifacts = [
    { id: 'a.yaml', type: 'openapi', before: '1', after: '2' },
    { id: 'b.yaml', type: 'openapi', before: '3', after: '4' },
  ];
  const claim = buildGateCompletenessClaim(artifacts);
  assert.equal(claim.source, 'gate-derived');
  assert.equal(claim.require_full_coverage, true);
  assert.equal(claim.completeness_count, 2);
  assert.equal(claim.leaves.length, 2);
  assert.deepEqual(claim.leaves.map((L) => L.path).sort(), [
    'openapi:a.yaml',
    'openapi:b.yaml',
  ]);
});

test('two-file git diff: gate sends N leaves with N artifacts (not a subset)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nfiles-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'api/a.yaml'), SPEC_A);
  fs.writeFileSync(path.join(dir, 'api/b.yaml'), SPEC_B);
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'api/a.yaml'), SPEC_A2);
  fs.writeFileSync(path.join(dir, 'api/b.yaml'), SPEC_B2);
  g('add', '-A'); g('commit', '-q', '-m', 'head');
  const headSha = g('rev-parse', 'HEAD').trim();

  const derived = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd: dir });
  assert.equal(derived.artifacts.length, 2, 'fixture: two contract files changed');

  const signer = newSigner('n-k1');
  const keyringPath = writeKeyringFile(dir, signer);
  const captured = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: async (opts) => {
      captured.opts = opts;
      const ctx = opts.context || {};
      const env = envelope({
        execution_action: 'CONTINUE',
        decision: 'ALLOW',
        extra: {
          preflight_mode: opts.preflight_mode || 'authorize',
          operation: ctx.operation,
          repository: ctx.repository,
          base: ctx.base,
          head: ctx.head,
        },
      });
      return { chain_receipt: mintV4(signer, env), decision_result: env };
    },
    postCheckRunImpl: async () => ({ ok: true, status: 201 }),
    log: () => {},
  });
  assert.equal(res.exitCode, 0);
  assert.equal(captured.opts.artifacts.length, 2);
  assert.equal(captured.opts.context.completeness.leaves.length, 2);
  assert.equal(captured.opts.context.completeness.completeness_count, 2);
  assert.equal(captured.opts.context.require_completeness, 'attested');
  // Honest gate path never drops an artifact it derived — N-1 is a SERVER
  // fail-closed when a host claim lists extra leaves (app completeness tests).
  fs.rmSync(dir, { recursive: true, force: true });
});
