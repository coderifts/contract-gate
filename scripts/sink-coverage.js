#!/usr/bin/env node
'use strict';

/**
 * 1315 — sink_coverage: the benchmark's largest `does_not_prove`, measured for ONE sink.
 *
 * WHAT THE BENCHMARK MEASURES TODAY. `selection_coverage` answers "did the model CALL CodeRifts
 * when it should have". It stops there, and says so: north-star.json carries
 * `sink_coverage: {status: "not_measured"}` and selectbench-run.js:74 hard-codes the string.
 * A model can select perfectly and the change can still reach `main` with nothing verifying it —
 * selection is a decision to ask, not evidence that anything acted on the answer.
 *
 * WHAT THIS ADDS. For each eligible change it goes one leg further: request an authorize decision,
 * then put the receipt that comes back through the MERGE SINK'S OWN VERIFIER — the pinned keyring
 * in this repository, the one the Action uses — and ask whether it is currently authorized for a
 * merge. The number is
 *
 *     sink_coverage = eligible changes that reached the sink with a currently-valid receipt
 *                     ─────────────────────────────────────────────────────────────────────
 *                                        eligible changes
 *
 * NOT ASSERTED, DERIVED. Every numerator increment comes from `verifyReceipt` returning
 * VERIFIED_CURRENT over bytes the live server signed. A case with no receipt is counted in the
 * denominator and NOT in the numerator — "the model chose well and nothing was issued" is a miss
 * at this leg, which is the whole point of measuring it separately from selection.
 *
 * WHAT IT DOES NOT PROVE — carried into the emitted document, not left to the reader:
 *   · ONE sink (merge), in a demo. Not deploy, not publish, not tool-call.
 *   · A verifiable receipt EXISTED, not that GitHub refused a merge without one. Provider
 *     enforcement is provider-enforcement-result.v1 and is a different measurement.
 *   · Corpus cases, not production traffic.
 *
 *   node scripts/sink-coverage.js                 # live run against the public endpoint
 *   node scripts/sink-coverage.js --out <path>
 */

const fs = require('fs');
const path = require('path');
const { verifyReceipt, keyringFromDocument } = require('../src/verify');

const MCP = 'https://app.coderifts.com/mcp';
const KEYRING = path.join(__dirname, '..', 'keyring', 'pinned-keys.json');

/**
 * The eligible set: corpus cases whose expected tool IS preflight. Eligibility follows the CORPUS,
 * never the outcome — a case does not stop being eligible because the run failed on it.
 */
function eligibleCases(fixturesPath) {
  const all = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  return all.filter((c) => c.expected_tool === 'coderifts.preflight_change_set');
}

/** A minimal but REAL contract change per case — the sink needs something to decide about. */
function changeFor(c) {
  const before = 'openapi: 3.0.0\ninfo: { title: T, version: 1.0.0 }\npaths:\n  /x:\n    get:\n      responses:\n        "200": { description: ok }\n';
  const after = before.replace('        "200": { description: ok }\n', '        "201": { description: created }\n');
  return { id: c.id, type: 'openapi', before, after };
}

async function authorize(c, fetchImpl) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'preflight_change_set',
      arguments: {
        preflight_mode: 'authorize',
        artifacts: [changeFor(c)],
        context: { operation: 'merge', environment: 'production' },
      },
    },
  };
  const res = await fetchImpl(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res || res.status !== 200) return { ok: false, reason: `http_${res ? res.status : 'none'}` };
  const doc = await res.json();
  const r = doc && doc.result;
  if (!r) return { ok: false, reason: 'no_result' };
  let sc = r.structuredContent;
  if (!sc && Array.isArray(r.content) && r.content[0] && r.content[0].text) {
    try { sc = JSON.parse(r.content[0].text); } catch (_) { sc = null; }
  }
  if (!sc) return { ok: false, reason: 'unparseable_result' };
  return { ok: true, receipt: sc.chain_receipt || null, decision: sc.decision || null };
}

/**
 * THE SINK. Not a re-implementation: the same verifyReceipt and the same pinned keyring the
 * contract-gate Action uses on a merge.
 */
function throughMergeSink(receipt, keyring) {
  if (!receipt) return { covered: false, reason: 'no_receipt_issued' };
  // expectedKid is REQUIRED by the ctx contract (verify.js:219, `string|null`) — not optional.
  // Omitting it silently returns UNKNOWN_KEY for a receipt whose kid IS in the keyring, because
  // `ctx.expectedKid !== null` is true for undefined (verify.js:127). Measured the hard way: the
  // first run of this script reported sink_coverage 0/9 for that reason alone.
  const v = verifyReceipt(receipt, { ctx: { keyring, expectedKid: null } });
  if (!v || v.valid !== true) {
    return { covered: false, reason: `receipt_not_valid:${(v && v.status) || 'unknown'}` };
  }
  return { covered: true, reason: null, status: v.status };
}

async function run({ fixturesPath, fetchImpl = fetch, keyringPath = KEYRING } = {}) {
  // keyringFromDocument, not the raw JSON: verifyReceipt wants a Map. Using the repo's own
  // loader keeps this the SAME keyring the Action verifies against, not a second reading of it.
  const keyring = keyringFromDocument(JSON.parse(fs.readFileSync(keyringPath, 'utf8')), keyringPath);
  const cases = eligibleCases(fixturesPath);
  const rows = [];
  for (const c of cases) {
    let a;
    try { a = await authorize(c, fetchImpl); } catch (e) { a = { ok: false, reason: `error:${e.message}` }; }
    const sink = a.ok ? throughMergeSink(a.receipt, keyring) : { covered: false, reason: a.reason };
    rows.push({
      case_id: c.id,
      decision: a.ok ? a.decision : null,
      receipt_present: !!(a.ok && a.receipt),
      covered: sink.covered,
      reason: sink.reason,
      verify_status: sink.status || null,
    });
  }
  const eligible = rows.length;
  const covered = rows.filter((r) => r.covered).length;
  return {
    metric: 'sink_coverage',
    sink: 'merge (contract-gate pinned keyring)',
    eligible,
    covered,
    sink_coverage: eligible > 0 ? covered / eligible : null,
    measured_at: null, // stamped by the caller — this function must stay deterministic
    is: 'Of the eligible changes, the share for which an authorize decision produced a receipt that '
      + "the merge sink's own verifier accepts as currently valid.",
    does_not_prove: [
      'ONE sink (merge) in a demo — not deploy, not publish, not tool-call.',
      'That a provider REFUSED a merge without one. Enforcement is provider-enforcement-result.v1.',
      'Anything about production traffic: these are corpus cases.',
      'That the decision was correct — only that a valid receipt existed at the sink.',
    ],
    rows,
  };
}

module.exports = { run, eligibleCases, throughMergeSink };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const fixtures = process.env.CODERIFTS_FIXTURES
    || path.join(process.env.HOME || '', 'coderifts-app', 'test', 'tool-selection-fixtures.json');
  run({ fixturesPath: fixtures }).then((r) => {
    const doc = { ...r, measured_at: new Date().toISOString() };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (outIdx !== -1 && argv[outIdx + 1]) fs.writeFileSync(argv[outIdx + 1], text);
    process.stdout.write(`sink_coverage = ${doc.covered}/${doc.eligible} = ${doc.sink_coverage}\n`);
    for (const row of doc.rows) {
      process.stdout.write(`  ${row.case_id.padEnd(6)} ${row.covered ? 'COVERED  ' : 'not      '} ${row.reason || row.verify_status}\n`);
    }
  }).catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
}
