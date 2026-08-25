'use strict';
/**
 * The vendored classifier must answer identically to the real @coderifts/contract-path.
 * If this fails, src/contract-path.js has become the "second list" the package forbids.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mine = require('../src/contract-path.js');

const REAL = path.join(process.env.HOME, 'coderifts-app', 'packages', 'contract-path', 'index.cjs');
let real = null;
try { real = require(REAL); } catch { /* reported by the skip below, never silently */ }

const CORPUS = [
  'openapi.yaml', 'openapi.yml', 'api/openapi.json', 'swagger.json', 'docs/swagger-v2.yaml',
  'asyncapi.yaml', 'events/asyncapi.json', 'schema.graphql', 'schema.gql', 'proto/user.proto',
  'mcp.json', 'tools-catalog.json', 'mcp-manifest.json',
  'package.json', 'tsconfig.json', 'package-lock.json', '.github/workflows/ci.yml',
  'README.md', 'src/index.js', 'node_modules/x/openapi.yaml', 'vendor/openapi.yaml',
  'openapi', 'a/b/c/openapi.yaml', 'OPENAPI.YAML', 'deep/nested/mcp/servers.json',
];

test('MIRROR: looksLikeContractPath matches the real package on the whole corpus', (t) => {
  if (!real) return t.skip('coderifts-app/packages/contract-path not present — mirror UNVERIFIED');
  for (const p of CORPUS) {
    assert.equal(mine.looksLikeContractPath(p), real.looksLikeContractPath(p), `looksLikeContractPath(${p})`);
  }
});

test('MIRROR: typeForPath matches the real package on every contract path', (t) => {
  if (!real) return t.skip('coderifts-app/packages/contract-path not present — mirror UNVERIFIED');
  for (const p of CORPUS.filter((x) => mine.looksLikeContractPath(x))) {
    assert.equal(mine.typeForPath(p), real.typeForPath(p), `typeForPath(${p})`);
  }
});

test('the honest edges hold: build files are not contracts, vendored paths are excluded', () => {
  for (const p of ['package.json', 'tsconfig.json', 'package-lock.json', '.github/workflows/ci.yml']) {
    assert.equal(mine.looksLikeContractPath(p), false, p);
  }
  assert.equal(mine.looksLikeContractPath('node_modules/x/openapi.yaml'), false);
  assert.equal(mine.looksLikeContractPath('vendor/openapi.yaml'), false);
});
