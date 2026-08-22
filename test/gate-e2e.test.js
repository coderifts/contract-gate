'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runGate } = require('../src/index');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_EMPTY = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n';

const signer = newSigner('test-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-'));
const keyringPath = writeKeyringFile(tmp, signer);

function makeRepo(baseSpec, headSpec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-git-'));
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

/**
 * An HONEST server model: it governs whatever artifacts it is actually sent. Breaking after-content
 * (paths:{}) -> BLOCK; additive -> ALLOW. It mints a valid receipt bound to the decision envelope,
 * so the gate's verify path is fully real. `captured` records what artifacts the gate submitted.
 */
function mockPreflightServer(captured) {
  return async ({ artifacts, context = {}, preflight_mode = 'authorize' }) => {
    captured.artifacts = artifacts;
    const extra = {
      preflight_mode,
      operation: context.operation,
      repository: context.repository,
      base: context.base,
      head: context.head,
    };
    const breaking = artifacts.some((a) => /paths:\s*\{\}/.test(a.after));
    const env = breaking
      ? envelope({ execution_action: 'STOP', decision: 'BLOCK', extra })
      : envelope({ execution_action: 'CONTINUE', decision: 'ALLOW', extra });
    return { chain_receipt: mintV4(signer, env), decision_result: env };
  };
}

function capturingCheck(sink) {
  return async ({ conclusion }) => { sink.conclusion = conclusion; return { ok: true, status: 201 }; };
}

test('(a) breaking PR diff (path removed) => gate FAILS, merge blocked', async () => {
  const { dir, baseSha, headSha } = makeRepo(SPEC_USERS, SPEC_EMPTY);
  const captured = {}, check = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: mockPreflightServer(captured), postCheckRunImpl: capturingCheck(check), log: () => {},
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.pass, false);
  assert.equal(res.gate.decision, 'BLOCK');
  assert.equal(check.conclusion, 'failure');
});

test('(b) clean additive PR diff => gate PASSES with a verified receipt', async () => {
  const { dir, baseSha, headSha } = makeRepo(SPEC_USERS, SPEC_USERS_HEALTH);
  const captured = {}, check = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: mockPreflightServer(captured), postCheckRunImpl: capturingCheck(check), log: () => {},
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.gate.pass, true);
  assert.equal(res.gate.executionAction, 'CONTINUE');
  assert.equal(res.gate.receiptStatus, 'VERIFIED_CURRENT');
  assert.equal(check.conclusion, 'success');
});

test('(c) THE BYPASS: head diff is breaking -> gate submits the BREAKING artifact -> FAILS, no matter what a caller wants', async () => {
  // The PR head really removes /users. A malicious agent would love to preflight the clean base spec
  // and merge this. runGate has NO artifacts input; it derives from git. Prove the artifact SENT to
  // the server is the breaking head content, and the gate fails.
  const { dir, baseSha, headSha } = makeRepo(SPEC_USERS, SPEC_EMPTY);
  const captured = {}, check = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: mockPreflightServer(captured), postCheckRunImpl: capturingCheck(check), log: () => {},
  });
  assert.equal(captured.artifacts.length, 1);
  assert.equal(captured.artifacts[0].after, SPEC_EMPTY);          // breaking head content was sent
  assert.notEqual(captured.artifacts[0].after, SPEC_USERS);       // NOT the clean base spec
  assert.equal(res.exitCode, 1);                                  // => blocked
  assert.equal(check.conclusion, 'failure');
});

test('(d) tampered receipt from a rogue server => fail-closed (exit 1)', async () => {
  const { dir, baseSha, headSha } = makeRepo(SPEC_USERS, SPEC_USERS_HEALTH);
  const rogue = async () => {
    const env = envelope({ execution_action: 'CONTINUE', decision: 'ALLOW' });
    const rogueSigner = newSigner('rogue-k1'); // NOT in the pinned/test keyring
    return { chain_receipt: mintV4(rogueSigner, env), decision_result: env };
  };
  const check = {};
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: rogue, postCheckRunImpl: capturingCheck(check), log: () => {},
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.pass, false);
  assert.equal(check.conclusion, 'failure');
});

test('(e) BLOCK/RA decision with a valid receipt => still fails', async () => {
  const { dir, baseSha, headSha } = makeRepo(SPEC_USERS, SPEC_USERS_HEALTH);
  const ra = async () => {
    const env = envelope({ execution_action: 'REQUEST_APPROVAL', decision: 'REQUIRE_APPROVAL' });
    return { chain_receipt: mintV4(signer, env), decision_result: env };
  };
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath, preflightImpl: ra, postCheckRunImpl: async () => ({ ok: true, status: 201 }), log: () => {},
  });
  assert.equal(res.exitCode, 1);
  assert.equal(res.gate.reason, 'decision_not_allow');
});

test('no contract files changed => PASS (nothing to govern)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-e2e-nc-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), 'a\n'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'README.md'), 'b\n'); g('add', '-A'); g('commit', '-q', '-m', 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  let called = false;
  const res = await runGate({
    apiKey: 'k', apiUrl: 'https://x', githubToken: 't', owner: 'o', repo: 'r',
    baseSha, headSha, cwd: dir, keyringPath,
    preflightImpl: async () => { called = true; return {}; }, postCheckRunImpl: async () => ({ ok: true, status: 201 }), log: () => {},
  });
  assert.equal(res.exitCode, 0);
  assert.equal(res.gate.reason, 'no_contract_changes');
  assert.equal(called, false); // never called preflight — nothing to govern
});
