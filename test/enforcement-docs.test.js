'use strict';

/**
 * Drift guard for R2 enforcement wiring. The required-status-check context MUST byte-match the name
 * the action posts (src/check-run.js CHECK_NAME) everywhere it is referenced — a mismatch makes
 * branch protection silently never block (ENFORCEMENT.md, "the #1 misconfiguration"). These tests
 * fail loudly if the workflow, setup script, or docs drift from the source-of-truth string.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHECK_NAME } = require('../src/check-run');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('CHECK_NAME is the exact, stable context string', () => {
  assert.equal(CHECK_NAME, 'CodeRifts / contract-gate');
});

test('the setup script pins the SAME context as CHECK_NAME', () => {
  const s = read('scripts/require-contract-gate.sh');
  assert.ok(s.includes(`CONTEXT="${CHECK_NAME}"`), 'require-contract-gate.sh CONTEXT must equal CHECK_NAME');
  // and it must close both bypasses:
  assert.match(s, /"strict":\s*true/);
  assert.match(s, /"enforce_admins":\s*true/);
});

test('ENFORCEMENT.md documents the exact context string + strict + admins', () => {
  const d = read('ENFORCEMENT.md');
  assert.ok(d.includes(CHECK_NAME), 'ENFORCEMENT.md must contain the exact context string');
  assert.ok(d.includes('"strict": true') || d.includes('strict = true') || /strict/.test(d));
  assert.match(d, /enforce_admins/);
});

test('example workflow is fail-closed-on-absence: runs on every PR, no path filter, right perms', () => {
  const w = read('examples/contract-gate.yml');
  assert.match(w, /on:\s*\n\s*pull_request:/, 'must trigger on pull_request');
  assert.ok(!/\n\s*paths:/.test(w), 'must NOT have a paths: filter (would skip contract PRs)');
  assert.match(w, /fetch-depth:\s*0/, 'must checkout full history for base...head diff');
  assert.match(w, /checks:\s*write/);
  assert.match(w, /contents:\s*read/);
  assert.ok(w.includes('coderifts/contract-gate@'), 'must invoke the gate action');
});

test('SECURITY.md documents the admin-override residual + pinned kid', () => {
  const s = read('SECURITY.md');
  assert.match(s, /enforce_admins/);
  assert.ok(s.includes('2026-07-k1'), 'must state the pinned kid');
});
