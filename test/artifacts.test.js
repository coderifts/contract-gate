'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { deriveArtifactsFromDiff, classify } = require('../src/artifacts');

const SPEC_USERS = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths:\n  /users:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_USERS_HEALTH = SPEC_USERS + '  /health:\n    get: { responses: { "200": { description: ok } } }\n';
const SPEC_EMPTY = 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n';

/** Build a git repo whose base commit has `baseFiles` and head branch has `headFiles`. */
function makeRepo(baseFiles, headFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-git-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  for (const [p, c] of Object.entries(baseFiles)) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  g('add', '-A'); g('commit', '-q', '-m', 'base');
  const baseSha = g('rev-parse', 'HEAD').trim();
  g('checkout', '-q', '-b', 'feature');
  // apply head state: rewrite/remove/add
  for (const p of Object.keys(baseFiles)) { if (!(p in headFiles)) fs.rmSync(path.join(dir, p)); }
  for (const [p, c] of Object.entries(headFiles)) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  g('add', '-A'); g('commit', '-q', '-m', 'head');
  const headSha = g('rev-parse', 'HEAD').trim();
  return { dir, baseSha, headSha };
}

test('additive change (new /health path) -> one openapi artifact, before=base after=head', () => {
  const { dir, baseSha, headSha } = makeRepo({ 'api/openapi.yaml': SPEC_USERS }, { 'api/openapi.yaml': SPEC_USERS_HEALTH });
  const { artifacts } = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd: dir });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].type, 'openapi');
  assert.equal(artifacts[0].id, 'api/openapi.yaml');
  assert.equal(artifacts[0].before, SPEC_USERS);
  assert.equal(artifacts[0].after, SPEC_USERS_HEALTH);
});

test('breaking change (path removed) -> artifact after-content reflects the REMOVAL', () => {
  const { dir, baseSha, headSha } = makeRepo({ 'api/openapi.yaml': SPEC_USERS }, { 'api/openapi.yaml': SPEC_EMPTY });
  const { artifacts } = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd: dir });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].after, SPEC_EMPTY);      // the real breaking head content
  assert.notEqual(artifacts[0].after, artifacts[0].before);
});

test('GAP-5 anti-bypass: artifacts are read from the head blob, not from any input', () => {
  const { dir, baseSha, headSha } = makeRepo({ 'api/openapi.yaml': SPEC_USERS }, { 'api/openapi.yaml': SPEC_EMPTY });
  // Even if a caller tried to pass a clean base spec, deriveArtifactsFromDiff accepts no such input —
  // it only takes refs. The derived `after` is exactly the (breaking) HEAD blob.
  const cleanBaseSubmission = { artifacts: [{ id: 'api/openapi.yaml', type: 'openapi', before: SPEC_USERS, after: SPEC_USERS }] };
  const { artifacts } = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd: dir, ...cleanBaseSubmission });
  assert.equal(artifacts[0].after, SPEC_EMPTY);   // ignored the injected clean `artifacts`; used git HEAD
  assert.equal(artifacts[0].before, SPEC_USERS);
  assert.notEqual(artifacts[0].after, SPEC_USERS);
});

test('non-contract file change -> no artifacts', () => {
  const { dir, baseSha, headSha } = makeRepo({ 'README.md': 'a\n' }, { 'README.md': 'b\n' });
  const { artifacts, allChanged } = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd: dir });
  assert.equal(artifacts.length, 0);
  assert.deepEqual(allChanged, ['README.md']);
});

test('identical-bytes (no material change) contract file is skipped', () => {
  const { dir, baseSha, headSha } = makeRepo({ 'api/openapi.yaml': SPEC_USERS, 'x.txt': '1' }, { 'api/openapi.yaml': SPEC_USERS, 'x.txt': '2' });
  const { artifacts } = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd: dir });
  assert.equal(artifacts.length, 0); // openapi.yaml unchanged; only x.txt moved
});

test('classify maps the contract families', () => {
  assert.equal(classify('api/openapi.yaml'), 'openapi');
  assert.equal(classify('petstore-api.json'), 'openapi');
  assert.equal(classify('schema.graphql'), 'graphql');
  assert.equal(classify('proto/user.proto'), 'grpc');
  assert.equal(classify('asyncapi.yaml'), 'asyncapi');
  assert.equal(classify('mcp.json'), 'mcp_manifest');
  assert.equal(classify('src/util.ts'), null);
  assert.equal(classify('README.md'), null);
});
