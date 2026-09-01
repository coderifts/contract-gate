'use strict';

/**
 * Two additive surfaces: a configurable check-run name, and the decision's own next step.
 *
 * The load-bearing assertions are the ones about what did NOT change. The default check name
 * is the documented required-check context (ENFORCEMENT.md), so it is asserted byte-for-byte
 * against the string branch protection is configured with — a drift there silently un-requires
 * the gate on every repo that set it up.
 *
 * And a policy refusal must never render a deny-remedy block. That schema says "call
 * preflight_change_set in authorize mode", which is the right answer for a missing or invalid
 * grant and the wrong one for a decision that verified a receipt and said no.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateGate, nextStepBlock, readNextAgentStep } = require('../src/gate');
const { postCheckRun, CHECK_NAME } = require('../src/check-run');
const { loadKeyring } = require('../src/verify');
const { newSigner, mintV4, writeKeyringFile, envelope } = require('./mint');

/** The literal string ENFORCEMENT.md tells an operator to add to branch protection. */
const DOCUMENTED_CONTEXT = 'CodeRifts / contract-gate';

const signer = newSigner('next-step-k1');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nextstep-'));
const keyringFile = writeKeyringFile(tmp, signer);
const keyring = () => loadKeyring(keyringFile);

const CTX = { operation: 'merge', repository: 'acme/api', base: 'base-aaa', head: 'head-bbb' };
const bound = (execution_action) => envelope({
  execution_action,
  decision: execution_action === 'CONTINUE' ? 'ALLOW' : 'BLOCK',
  extra: {
    preflight_mode: 'authorize',
    operation: CTX.operation, repository: CTX.repository, base: CTX.base, head: CTX.head,
  },
});

const STEP = Object.freeze({
  action: 're_preflight',
  reason: 'breaking_changes',
  resume_condition: 'A currently-authorized receipt for the amended change set',
  then_call: 'preflight_change_set',
});

async function gateWith(execution_action, control_envelope) {
  const env = bound(execution_action);
  return evaluateGate({
    preflightResponse: {
      chain_receipt: mintV4(signer, env),
      decision_result: env,
      ...(control_envelope === undefined ? {} : { control_envelope }),
    },
    keyring: await keyring(),
    headSha: CTX.head,
    expectedContext: CTX,
    repository: CTX.repository,
  });
}

// ── the check name ──────────────────────────────────────────────────────────
describe('check-name — the default is the documented required-check context', () => {
  it('CHECK_NAME is byte-for-byte the string ENFORCEMENT.md tells operators to require', () => {
    assert.equal(CHECK_NAME, DOCUMENTED_CONTEXT);
  });

  it('the documented context appears verbatim in ENFORCEMENT.md', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'ENFORCEMENT.md'), 'utf8');
    assert.ok(doc.includes(DOCUMENTED_CONTEXT), 'the required-check contract must name this string');
  });

  it("action.yml's check-name default is the same string", () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
    const block = yml.slice(yml.indexOf('check-name:'));
    assert.match(block.slice(0, 400), new RegExp(`default: '${DOCUMENTED_CONTEXT}'`));
  });

  const capture = () => {
    const seen = {};
    return {
      seen,
      fetchImpl: async (url, init) => {
        Object.assign(seen, { url, body: JSON.parse(init.body) });
        return { status: 201 };
      },
    };
  };

  it('with no checkName the posted name is unchanged', async () => {
    const { seen, fetchImpl } = capture();
    await postCheckRun({
      token: 't', owner: 'o', repo: 'r', headSha: 'h',
      conclusion: 'failure', title: 'x', summary: 'y', fetchImpl,
    });
    assert.equal(seen.body.name, DOCUMENTED_CONTEXT);
  });

  it('a supplied checkName is what gets posted', async () => {
    const { seen, fetchImpl } = capture();
    await postCheckRun({
      token: 't', owner: 'o', repo: 'r', headSha: 'h',
      conclusion: 'failure', title: 'x', summary: 'y',
      checkName: 'contract-gate (Action)', fetchImpl,
    });
    assert.equal(seen.body.name, 'contract-gate (Action)');
  });

  it('an empty or blank checkName falls back to the default rather than posting a nameless check', async () => {
    for (const blank of ['', '   ', null, undefined]) {
      const { seen, fetchImpl } = capture();
      // eslint-disable-next-line no-await-in-loop
      await postCheckRun({
        token: 't', owner: 'o', repo: 'r', headSha: 'h',
        conclusion: 'failure', title: 'x', summary: 'y', checkName: blank, fetchImpl,
      });
      assert.equal(seen.body.name, DOCUMENTED_CONTEXT, `blank ${JSON.stringify(blank)}`);
    }
  });
});

// ── next_agent_step ─────────────────────────────────────────────────────────
describe('next_agent_step — the decision\'s own remediation', () => {
  it('a BLOCK carrying a step renders it, verbatim, under its own heading', async () => {
    const g = await gateWith('STOP', { next_agent_step: STEP });
    assert.equal(g.reason, 'decision_not_allow');
    assert.deepEqual(g.nextStep, STEP);
    assert.ok(g.summary.includes('### Next step (from the decision)'));
    for (const value of [STEP.action, STEP.reason, STEP.resume_condition, STEP.then_call]) {
      assert.ok(g.summary.includes(value), `missing ${value}`);
    }
    assert.ok(g.summary.includes(
      "This is the decision's remediation suggestion, not permission; branch on execution_action.",
    ));
  });

  it('a BLOCK with no step renders NO heading — an absent step is not invented', async () => {
    for (const control of [{ next_agent_step: null }, {}, undefined]) {
      // eslint-disable-next-line no-await-in-loop
      const g = await gateWith('STOP', control);
      assert.equal(g.reason, 'decision_not_allow');
      assert.ok(!('nextStep' in g), `unexpected nextStep for ${JSON.stringify(control)}`);
      assert.ok(!g.summary.includes('Next step (from the decision)'));
    }
  });

  it('a step without an action is not a step', async () => {
    const g = await gateWith('STOP', { next_agent_step: { reason: 'x', then_call: 'y' } });
    assert.ok(!('nextStep' in g));
    assert.ok(!g.summary.includes('Next step (from the decision)'));
  });

  it('an ALLOW renders no next-step section', async () => {
    const g = await gateWith('CONTINUE', { next_agent_step: null });
    assert.equal(g.pass, true);
    assert.ok(!g.summary.includes('Next step (from the decision)'));
  });

  it('the conclusion is untouched: a rendered step does not soften the failure', async () => {
    const withStep = await gateWith('STOP', { next_agent_step: STEP });
    const without = await gateWith('STOP', { next_agent_step: null });
    assert.equal(withStep.pass, false);
    assert.equal(withStep.conclusion, 'failure');
    // Every verdict field matches the run that carried no step.
    for (const k of ['pass', 'conclusion', 'reason', 'decision', 'executionAction', 'receiptStatus', 'headSha']) {
      assert.equal(withStep[k], without[k], `${k} moved`);
    }
  });

  it('a policy refusal carries NO deny-remedy block — a BLOCK is not a missing grant', async () => {
    const g = await gateWith('STOP', { next_agent_step: STEP });
    assert.ok(!('remedy' in g), 'decision_not_allow must not claim a grant would fix it');
    assert.ok(!g.summary.includes('```json'));
    assert.ok(!g.summary.includes('To obtain a grant for this change set:'));
  });

  it('missing_receipt is unchanged: deny-remedy block, and no next-step heading', async () => {
    const g = await evaluateGate({
      preflightResponse: { decision_result: bound('CONTINUE'), control_envelope: { next_agent_step: STEP } },
      keyring: await keyring(),
      headSha: CTX.head,
      expectedContext: CTX,
      repository: CTX.repository,
    });
    assert.equal(g.reason, 'missing_receipt');
    assert.equal(g.remedy.error, 'CODERIFTS_GRANT_REQUIRED');
    assert.ok(g.summary.includes('```json'));
    // The step exists in the response, but this refusal is not the decision's refusal.
    assert.ok(!g.summary.includes('Next step (from the decision)'));
  });

  it('readNextAgentStep refuses malformed shapes rather than passing them through', () => {
    assert.equal(readNextAgentStep(null), null);
    assert.equal(readNextAgentStep({}), null);
    assert.equal(readNextAgentStep({ control_envelope: null }), null);
    assert.equal(readNextAgentStep({ control_envelope: { next_agent_step: 'go' } }), null);
    assert.equal(readNextAgentStep({ control_envelope: { next_agent_step: { action: '' } } }), null);
  });

  it('nextStepBlock omits fields the server left empty and never fabricates them', () => {
    const block = nextStepBlock({ action: 'escalate', reason: 'x', resume_condition: '', then_call: null });
    assert.ok(block.includes('- action: `escalate`'));
    assert.ok(!block.includes('resume_condition'));
    assert.ok(!block.includes('then_call'));
    assert.equal(nextStepBlock(null), null);
  });
});
