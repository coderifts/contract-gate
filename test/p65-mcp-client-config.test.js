'use strict';

/*
 * P65 (2026-10-06, the owner's decision) — the Action decides as the hooks and the App do: an MCP client
 * configuration is never a contract, by name, so it is never read from git and never sent to preflight.
 *
 * MEASURED (before): src/artifacts.js's own read list (`mcp[^/]*\.json`) matched `mcp.json`,
 * `.cursor/mcp.json`, `mcp_settings.json`, so the Action read the committed file at base and head
 * (env tokens included) and sent it as an mcp_manifest artifact.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveArtifactsFromDiff, classify } = require('../src/artifacts');

// P65c (2026-10-07): a plain `mcp.json` left this by-name list (test/p65c-mcp-json-by-content.test.js decides it).
const CLIENT_CONFIGS = ['.cursor/mcp.json', '.vscode/mcp.json', 'mcp_settings.json', 'cline_mcp_settings.json', '.mcp.json', 'claude_desktop_config.json'];

test('classify: an MCP client configuration is not a contract artifact', () => {
  for (const p of CLIENT_CONFIGS) assert.equal(classify(p), null, p);
  assert.equal(classify('tools-catalog.json'), 'mcp_manifest');
  assert.equal(classify('mcp-manifest.json'), 'mcp_manifest');
  assert.equal(classify('api/openapi.yaml'), 'openapi');
});

test('deriveArtifactsFromDiff never reads a changed client config from git', () => {
  const shown = [];
  const gitImpl = (args) => {
    if (args[0] === 'diff') return [...CLIENT_CONFIGS, 'api/openapi.yaml'].join('\n');
    if (args[0] === 'show' || args[0] === 'cat-file') { shown.push(args.join(' ')); return args.join(' ').includes('base') ? 'openapi: 3.0.0\n' : 'openapi: 3.0.1\n'; }
    return '';
  };
  const { artifacts, changedContractFiles } = deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl });
  assert.deepEqual(changedContractFiles, ['api/openapi.yaml']);
  assert.deepEqual(artifacts.map((a) => a.id), ['api/openapi.yaml']);
  assert.ok(!shown.some((s) => /mcp|claude_desktop/.test(s)), `read from git: ${shown.join(' | ')}`);
});
