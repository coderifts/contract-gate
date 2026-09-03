'use strict';

/**
 * CodeRifts contract-gate — server-independent merge enforcement.
 *
 * Flow (fail-closed at every step; any throw => FAIL check + exit 1):
 *   1. derive contract artifacts from the PR's ACTUAL head diff (git) — never caller input
 *   2. POST /api/v1/preflight with those artifacts -> chain_receipt + decision_result (v4)
 *   3. verify the receipt OFFLINE against the PINNED keyring (never fetch keys from the server)
 *   4. bind the signed envelope to the CURRENT PR identity (head/base/repo/operation/mode)
 *   5. pass IFF verified AND execution_action in {CONTINUE, CONTINUE_WITH_MONITORING}
 *      AND every expectedContext slot matches the envelope (missing ≠ match)
 *   6. post the "CodeRifts / contract-gate" Check Run (success only on pass)
 *
 * CWM honesty: with require_verified_monitoring: true the gate verifies a cr.monitor.attest.v1
 * token offline against a pinned monitoring keyring (CWM passes only on delivered_acked);
 * by default it passes CWM on the host's claim. The token proves a monitoring-key holder
 * observed the delivery — not that a human read it, not that the sink targets the right audience.
 */

const path = require('node:path');
const fs = require('node:fs');
const { deriveArtifactsFromDiff, defaultGit } = require('./artifacts');
const { buildGateCompletenessClaim } = require('./completeness-claim');
const { callPreflight } = require('./preflight');
const { evaluateGate, buildSummary, remedyBlock, nextStepBlock } = require('./gate');
const { postCheckRun, CHECK_NAME } = require('./check-run');
const { loadKeyring } = require('./verify');
const { verifyExecutionGrant } = require('./execution-grant-verify');
const { deriveGovernedArtifacts } = require('./governed-paths');
const { loadMonitoringKeyring } = require('./monitoring-attestation');
const { selectGrantForHead } = require('./grant-delivery');

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
function parseBoolInput(v, fallback = false) {
  if (v == null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return fallback;
}

async function runGate({
  apiKey, apiUrl, githubToken, checkName, owner, repo, baseSha, headSha, cwd,
  keyringPath = PINNED_KEYRING_PATH,
  gitImpl = defaultGit,
  preflightImpl = callPreflight,
  postCheckRunImpl = postCheckRun,
  fetchImpl,
  log = console.error,
  requireVerifiedMonitoring = false,
  monitoringAttestation = null,
  monitoringKeyringPath = null,
  requireGrant = false,
  executionGrant = null,
  grantKeyringPath = null,
  grantOperation = 'merge',
  grantComments = null,
  bundlePath = null,
  bundleSlotKeysPath = null,
  // 1334 — default TRUE so every existing consumer is byte-identical.
  postCheckRun: postCheckRun_ = true,
}) {
  const emitCheck = async (conclusion, title, summary, text = null) => {
    // 1334 — DELIBERATE opt-out, distinct from "we had no token".
    //
    // MEASURED on coderifts/demo PR#4 (2026-09-03): three contract-gate check-runs on one head.
    //   CodeRifts / contract-gate (Action)   app 15368  — this Action, via check-name override
    //   contract-gate (Action)               app 15368  — the workflow JOB's own check
    //   CodeRifts / contract-gate            app 2860592 — the App webhook: the REQUIRED one
    // The first is redundant: the App webhook already posts the required context under its own
    // identity. Worse, it cannot be fixed by dropping the override — the default name is the SAME
    // string the App posts, so the Action would then post a same-named check under a DIFFERENT
    // issuer (15368), which readback.js grades INDETERMINATE: two posters, and which one satisfied
    // the requirement cannot be read back.
    //
    // So the Action must post NOTHING where the App covers the check. `post-check-run: false` says
    // that, and says it distinctly from the token-missing skip below — an operator reading the log
    // must be able to tell "configured not to" from "could not".
    if (postCheckRun_ === false) {
      log(`[check not posted — post-check-run:false] ${conclusion}: ${title}`);
      return;
    }
    if (!githubToken || !owner || !repo || !headSha) { log(`[check skipped] ${conclusion}: ${title}`); return; }
    try {
      const r = await postCheckRunImpl({ token: githubToken, owner, repo, headSha, conclusion, title, summary, text, checkName, fetchImpl });
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

    // 2. preflight (v4 receipt path). Decision Spec 2.0: authorize (gate ENFORCES merge, needs a
    // receipt). Source binding is context.head / context.base — producer copies those into the
    // signed envelope (ID686). `revision` is not a producer slot (would leave envelope.head unbound).
    const context = {
      operation: 'merge',
      environment: 'ci',
      repository: `${owner}/${repo}`,
      base: baseSha,
      head: headSha,
      // Existing ID637 host-claim slots (not a new schema). Fail-closed when
      // artifacts ⊂ derived leaves. source is request-only, not signed.
      completeness: buildGateCompletenessClaim(artifacts),
      require_completeness: 'attested',
    };
    const preflightResponse = await preflightImpl({
      apiKey, apiUrl, artifacts, context, preflight_mode: 'authorize', fetchImpl,
    });

    // 3-5. verify offline against the PINNED keyring + rebind to THIS PR (P0-1).
    // Current head/base come from GITHUB_EVENT_PATH pull_request.head/base.sha (not GITHUB_SHA).
    const keyring = await loadKeyring(keyringPath); // local file -> NO network, never the server under test
    const expectedContext = {
      operation: context.operation,
      repository: context.repository,
      base: context.base,
      head: context.head,
    };
    let monitoringKeyring = null;
    if (monitoringKeyringPath) {
      monitoringKeyring = loadMonitoringKeyring(monitoringKeyringPath);
    }
    // require-grant: derive the governed set from the SAME diff the gate already read, then
    // verify the supplied grant offline. Both only when the flag is on — with it off nothing here
    // runs and the call below is byte-identical to the pre-feature one.
    let grantResult = null;
    let governedArtifacts = null;
    if (requireGrant === true) {
      governedArtifacts = deriveGovernedArtifacts({
        changed: artifacts.map((a) => ({
          path: a.id, after: a.after, unreadable: a.unreadable === true,
        })),
      });
      let tokenStr = typeof executionGrant === 'string' ? executionGrant.trim() : '';
      if (!tokenStr && Array.isArray(grantComments)) {
        const sel = selectGrantForHead(grantComments, headSha);
        if (!sel.ok && sel.reason === 'grant_bound_elsewhere') {
          grantResult = { valid: false, status: 'GRANT_UNBOUND', reason: 'grant_bound_elsewhere' };
        } else if (sel.ok) {
          tokenStr = sel.grant;
        }
      }
      if (tokenStr && !(grantResult && grantResult.status === 'GRANT_UNBOUND')) {
        // No network fetch of keys: the keyring is a local pinned document, same loader as receipts.
        const grantKeyring = grantKeyringPath ? await loadKeyring(grantKeyringPath) : keyring;
        grantResult = verifyExecutionGrant(tokenStr, { keyring: grantKeyring, context: expectedContext });
      }
    }

    // ── crbundle.v1 input (1261) ────────────────────────────────────────────────────────────
    //
    // Read from a FILE path, not from an inline string: a bundle carries several signed tokens and
    // is far past a sensible Action-input size, and a workflow that already produced one has it on
    // disk. Unreadable or unparseable is a REFUSAL, not a skip — a gate asked to check a bundle
    // that then quietly checks nothing is the failure mode this whole item is about.
    let proofBundle = null;
    let bundleOpts = null;
    if (bundlePath) {
      try {
        proofBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      } catch (err) {
        const reason = 'bundle_unreadable';
        const summary = `proof bundle at ${bundlePath} could not be read or parsed: ${String((err && err.message) || 'unknown').slice(0, 160)}`;
        await emitCheck('failure', 'CodeRifts contract gate: failed', summary);
        return { exitCode: 1, gate: { pass: false, reason, summary }, artifactCount: 0 };
      }
      if (bundleSlotKeysPath) {
        try {
          bundleOpts = JSON.parse(fs.readFileSync(bundleSlotKeysPath, 'utf8'));
        } catch (err) {
          const reason = 'bundle_slot_keys_unreadable';
          const summary = `bundle slot keys at ${bundleSlotKeysPath} could not be read or parsed: ${String((err && err.message) || 'unknown').slice(0, 160)}`;
          await emitCheck('failure', 'CodeRifts contract gate: failed', summary);
          return { exitCode: 1, gate: { pass: false, reason, summary }, artifactCount: 0 };
        }
      }
    }

    const gate = evaluateGate({
      preflightResponse, keyring, headSha, expectedContext,
      require_verified_monitoring: requireVerifiedMonitoring === true,
      monitoring_attestation: monitoringAttestation,
      monitoring_keyring: monitoringKeyring,
      require_grant: requireGrant === true,
      grant_result: grantResult,
      governed_artifacts: governedArtifacts,
      grant_operation: grantOperation,
      proof_bundle: proofBundle,
      bundle_opts: bundleOpts,
      repository: context.repository,
    });

    // 6. post the stable check run.
    const title = gate.pass ? 'Signed ALLOW verified for this diff' : 'Blocked — no verified ALLOW for this diff';
    // output.text carries whichever machine-readable next step this refusal has. The two are
    // mutually exclusive by construction — a policy refusal maps to no remedy class — but they
    // are composed rather than assumed apart.
    const detail = [remedyBlock(gate.remedy), nextStepBlock(gate.nextStep)].filter(Boolean).join('\n\n');
    await emitCheck(gate.conclusion, title, gate.summary, detail || null);
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
    checkName: process.env['INPUT_CHECK-NAME'] || undefined,
    // Only the exact string 'false' turns it off — same bar as MERGEGATE_ENFORCE in the app.
    // Anything else (unset, '0', 'no') keeps the check posting, so a typo cannot silently
    // remove the gate's own check-run.
    postCheckRun: String(process.env['INPUT_POST-CHECK-RUN'] || '').toLowerCase() !== 'false',
    owner: ev.owner, repo: ev.repo, baseSha: ev.baseSha, headSha: ev.headSha,
    cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
    requireVerifiedMonitoring: parseBoolInput(process.env['INPUT_REQUIRE-VERIFIED-MONITORING'], false),
    monitoringAttestation: process.env['INPUT_MONITORING-ATTESTATION'] || null,
    monitoringKeyringPath: process.env['INPUT_MONITORING-KEYRING'] || null,
    requireGrant: parseBoolInput(process.env['INPUT_REQUIRE-GRANT'], false),
    executionGrant: process.env['INPUT_EXECUTION-GRANT'] || null,
    grantKeyringPath: process.env['INPUT_GRANT-KEYRING'] || null,
    grantOperation: process.env['INPUT_GRANT-OPERATION'] || 'merge',
    bundlePath: process.env['INPUT_BUNDLE'] || null,
    bundleSlotKeysPath: process.env['INPUT_BUNDLE-SLOT-KEYS'] || null,
  });
  process.exit(res.exitCode);
}

module.exports = { runGate, readEvent, PINNED_KEYRING_PATH, CHECK_NAME };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
