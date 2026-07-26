'use strict';

/**
 * CodeRifts contract-gate — server-independent merge enforcement.
 *
 * Flow (fail-closed at every step; any throw => FAIL check + exit 1):
 *   1. derive contract artifacts from the PR's ACTUAL head diff (git) — never caller input
 *   2. POST /api/v1/preflight with those artifacts -> chain_receipt + decision_result (v4)
 *   3. verify the receipt OFFLINE against the PINNED keyring (never fetch keys from the server)
 *   4. bind to head SHA (recorded in the check output)
 *   5. pass IFF verified AND execution_action in {CONTINUE, CONTINUE_WITH_MONITORING}
 *   6. post the "CodeRifts / contract-gate" Check Run (success only on pass)
 */

const path = require('node:path');
const fs = require('node:fs');
const { deriveArtifactsFromDiff, defaultGit } = require('./artifacts');
const { callPreflight } = require('./preflight');
const { evaluateGate, buildSummary } = require('./gate');
const { postCheckRun, CHECK_NAME } = require('./check-run');
const { loadKeyring } = require('./verify');

const PINNED_KEYRING_PATH = path.join(__dirname, '..', 'keyring', 'pinned-keys.json');

function readEvent(eventPath) {
  if (!eventPath || !fs.existsSync(eventPath)) throw new Error('GITHUB_EVENT_PATH missing (run on pull_request events)');
  const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  if (!ev.pull_request) throw new Error('event is not a pull_request');
  const [owner, repo] = String(ev.repository && ev.repository.full_name || '').split('/');
  return {
    owner, repo,
    baseSha: ev.pull_request.base && ev.pull_request.base.sha,
    headSha: ev.pull_request.head && ev.pull_request.head.sha,
  };
}

/**
 * Orchestrate one gate run. All I/O is injectable so tests exercise the real diff + verify paths
 * while mocking only the network (preflight, GitHub API).
 *
 * @returns {Promise<{exitCode:number, gate:object, artifactCount:number}>}
 */
async function runGate({
  apiKey, apiUrl, githubToken, owner, repo, baseSha, headSha, cwd,
  keyringPath = PINNED_KEYRING_PATH,
  gitImpl = defaultGit,
  preflightImpl = callPreflight,
  postCheckRunImpl = postCheckRun,
  fetchImpl,
  log = console.error,
}) {
  const emitCheck = async (conclusion, title, summary) => {
    if (!githubToken || !owner || !repo || !headSha) { log(`[check skipped] ${conclusion}: ${title}`); return; }
    try {
      const r = await postCheckRunImpl({ token: githubToken, owner, repo, headSha, conclusion, title, summary, fetchImpl });
      if (!r.ok) log(`[check-run] non-2xx: ${r.status}`);
    } catch (e) { log(`[check-run] error: ${e && e.message}`); }
  };

  try {
    if (!apiKey) throw new Error('api-key input is required');
    if (!baseSha || !headSha) throw new Error('could not resolve base/head SHA from the event');

    // 1. artifacts from the REAL diff — the anti-bypass invariant.
    const { artifacts, changedContractFiles } = deriveArtifactsFromDiff({ baseRef: baseSha, headRef: headSha, cwd, gitImpl });

    if (artifacts.length === 0) {
      const summary = [
        '✅ **CodeRifts contract-gate: PASS**', '',
        '- reason: `no_contract_changes`',
        `- head commit: \`${headSha}\``, '',
        'No contract artifacts changed in this diff (openapi/graphql/grpc/asyncapi/mcp-manifest). Nothing to govern.',
      ].join('\n');
      await emitCheck('success', 'No contract changes', summary);
      return { exitCode: 0, gate: { pass: true, reason: 'no_contract_changes' }, artifactCount: 0 };
    }

    // 2. preflight (v4 receipt path). context carries head SHA so the decision records what it covers.
    const context = { operation: 'merge', environment: 'ci', repository: `${owner}/${repo}`, revision: headSha };
    const preflightResponse = await preflightImpl({ apiKey, apiUrl, artifacts, context, fetchImpl });

    // 3-5. verify offline against the PINNED keyring + decide.
    const keyring = await loadKeyring(keyringPath); // local file -> NO network, never the server under test
    const gate = evaluateGate({ preflightResponse, keyring, headSha });

    // 6. post the stable check run.
    const title = gate.pass ? 'Signed ALLOW verified for this diff' : 'Blocked — no verified ALLOW for this diff';
    await emitCheck(gate.conclusion, title, gate.summary);
    log(`contract-gate: ${gate.pass ? 'PASS' : 'FAIL'} (${gate.reason}); files=${changedContractFiles.join(',')}`);
    return { exitCode: gate.pass ? 0 : 1, gate, artifactCount: artifacts.length };
  } catch (err) {
    const summary = buildSummary({ pass: false, reason: `error:${err && err.message ? err.message : 'unknown'}`, headSha });
    await emitCheck('failure', 'contract-gate error (fail-closed)', summary);
    log(`contract-gate error (fail-closed): ${err && err.stack ? err.stack : err}`);
    return { exitCode: 1, gate: { pass: false, reason: 'error' }, artifactCount: 0 };
  }
}

async function main() {
  const ev = readEvent(process.env.GITHUB_EVENT_PATH);
  const res = await runGate({
    apiKey: process.env['INPUT_API-KEY'] || process.env.CODERIFTS_API_KEY,
    apiUrl: process.env['INPUT_API-URL'] || 'https://app.coderifts.com',
    githubToken: process.env['INPUT_GITHUB-TOKEN'] || process.env.GITHUB_TOKEN,
    owner: ev.owner, repo: ev.repo, baseSha: ev.baseSha, headSha: ev.headSha,
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
  });
  process.exit(res.exitCode);
}

module.exports = { runGate, readEvent, PINNED_KEYRING_PATH, CHECK_NAME };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
