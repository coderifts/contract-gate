'use strict';

/*
 * P65c (2026-10-07, the owner's decision) — the Action decides a plain `mcp.json` by its content, after its
 * own `git show`, with the vendored copy of @coderifts/contract-path 1.3.0's function (mirror-tested).
 *
 * MEASURED (v0.11.3): every `mcp.json` was refused by name, so a server's tool manifest named `mcp.json`
 * (coderifts.com's own) was not a contract: a PR removing a tool from it passed `no_contract_changes`.
 * Now: client configuration (mcpServers / servers, no tools) → no file, never sent; tools → contract;
 * unparseable → contract (fail-closed). `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
 * `claude_desktop_config.json`, `(cline_)mcp_settings.json` stay refused by name and are never read.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { deriveArtifactsFromDiff, classify } = require('../src/artifacts');

const TOKEN = 'ghp_P65cGATE00000000000000000000000000000000';
const CLIENT = JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: TOKEN } } } }, null, 2);
const tools = (n) => JSON.stringify({ name: 'x', tools: n.map((name) => ({ name })) }, null, 2);

// coderifts.com/mcp.json as its generator writes it (in coderifts-app), when that checkout is here.
let WEBSITE = null;
try {
  const gen = require(path.join(process.env.HOME, 'coderifts-app', 'scripts', 'generate-mcp-json'));
  WEBSITE = gen.render(gen.buildMcpJson());
} catch { /* reported by the skip below */ }

function git(store, changed) {
  const shown = [];
  const impl = (args) => {
    if (args[0] === 'diff') return changed.join('\n');
    if (args[0] === 'rev-parse') return 'ok';
    if (args[0] === 'show') {
      shown.push(args[1]);
      if (Object.prototype.hasOwnProperty.call(store, args[1])) return store[args[1]];
      const e = new Error(`fatal: path '${args[1].split(':')[1]}' does not exist in '${args[1].split(':')[0]}'`);
      e.stderr = e.message;
      throw e;
    }
    return '';
  };
  return { impl, shown };
}

test('classify: a plain mcp.json is a candidate; the by-name client configurations are not', () => {
  assert.equal(classify('mcp.json'), 'mcp_manifest');
  assert.equal(classify('.well-known/mcp.json'), 'mcp_manifest');
  for (const p of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', 'claude_desktop_config.json', 'mcp_settings.json', 'cline_mcp_settings.json']) {
    assert.equal(classify(p), null, p);
  }
});

test('a PR that changes only a client configuration named mcp.json: no artifact, the token not in the change set', () => {
  const g = git({ 'base:mcp.json': CLIENT, 'head:mcp.json': CLIENT.replace(TOKEN, `${TOKEN}X`) }, ['mcp.json']);
  const out = deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl: g.impl });
  assert.deepEqual(out.artifacts, []);
  assert.deepEqual(out.changedContractFiles, []);
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test('the website\'s mcp.json (a manifest) is a contract again', (t) => {
  if (!WEBSITE) return t.skip('coderifts-app not present — the website file UNVERIFIED here');
  const j = JSON.parse(WEBSITE);
  const minus = JSON.stringify({ ...j, tools: j.tools.slice(0, -1) }, null, 2);
  const g = git({ 'base:mcp.json': WEBSITE, 'head:mcp.json': minus }, ['mcp.json']);
  const out = deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl: g.impl });
  assert.deepEqual(out.artifacts.map((a) => [a.id, a.type]), [['mcp.json', 'mcp_manifest']]);
});

test('a manifest turned into a client configuration: the manifest removed, the client side never in the change set', () => {
  const g = git({ 'base:mcp.json': tools(['a', 'b']), 'head:mcp.json': CLIENT }, ['mcp.json']);
  const out = deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl: g.impl });
  assert.equal(out.artifacts.length, 1);
  assert.equal(out.artifacts[0].after, '');
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test('unparseable: not sent, and held (P65d; v0.11.4 sent it as a contract)', () => {
  const g = git({ 'base:mcp.json': tools(['a']), 'head:mcp.json': '{ broken' }, ['mcp.json']);
  const out = deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl: g.impl });
  assert.equal(out.artifacts.length, 0);
  assert.deepEqual(out.held.map((h) => [h.path, h.kind]), [['mcp.json', 'unparseable']]);
});

test('the by-name client configurations are still never read from git', () => {
  const g = git({}, ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']);
  deriveArtifactsFromDiff({ baseRef: 'base', headRef: 'head', gitImpl: g.impl });
  assert.deepEqual(g.shown, []);
});
