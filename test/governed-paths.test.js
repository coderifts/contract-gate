'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveGovernedArtifacts } = require('../src/governed-paths');

test('classifies contract artifacts and types them via the single classifier', () => {
  const g = deriveGovernedArtifacts({ changed: [
    { path: 'api/openapi.yaml', after: 'a' },
    { path: 'schema.graphql', after: 'b' },
    { path: 'proto/user.proto', after: 'c' },
    { path: 'events/asyncapi.json', after: 'd' },
    { path: 'mcp.json', after: 'e' },
  ] });
  // sorted by path: api/openapi.yaml, events/asyncapi.json, mcp.json, proto/user.proto, schema.graphql
  assert.deepEqual(g.map((x) => x.id), [
    'api/openapi.yaml', 'events/asyncapi.json', 'mcp.json', 'proto/user.proto', 'schema.graphql']);
  assert.deepEqual(g.map((x) => x.type), ['openapi', 'asyncapi', 'mcp_manifest', 'grpc', 'graphql']);
});

test('non-contract files are not governed', () => {
  const g = deriveGovernedArtifacts({ changed: [
    { path: 'README.md', after: 'x' }, { path: 'src/index.js', after: 'y' },
    { path: 'package.json', after: '{}' }, { path: '.github/workflows/ci.yml', after: 'z' },
  ] });
  assert.deepEqual(g, []);
});

test('an unreadable governed path is CARRIED, never dropped', () => {
  const g = deriveGovernedArtifacts({ changed: [{ path: 'openapi.yaml', unreadable: true }] });
  assert.equal(g.length, 1);
  assert.equal(g[0].unreadable, true);
  assert.equal(g[0].after, undefined, 'no fabricated empty content for a blob we could not read');
});

test('ordering is stable so the recomputed payload is deterministic', () => {
  const a = deriveGovernedArtifacts({ changed: [{ path: 'b/openapi.yaml', after: '1' }, { path: 'a/openapi.yaml', after: '2' }] });
  const b = deriveGovernedArtifacts({ changed: [{ path: 'a/openapi.yaml', after: '2' }, { path: 'b/openapi.yaml', after: '1' }] });
  assert.deepEqual(a, b);
});

test('empty or missing input yields an empty governed set, not a throw', () => {
  assert.deepEqual(deriveGovernedArtifacts({ changed: [] }), []);
  assert.deepEqual(deriveGovernedArtifacts({}), []);
});
