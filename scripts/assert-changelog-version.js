#!/usr/bin/env node
'use strict';

/**
 * Release gate: refuse a version the CHANGELOG does not name.
 *
 * WHY THIS EXISTS — measured in this repository, not hypothetical. On 2026-09-01 the tags
 * `v0.5.0`, `v0.6.0` and `v0.7.0` all existed while `CHANGELOG.md` jumped from 0.8.0 straight to
 * 0.4.0. Three released versions were undocumented, and two of them (`v0.5.0`, `v0.6.0`) have no
 * GitHub release notes either — so for those the commit list was the only surviving record, and it
 * had to be reconstructed from `git log` after the fact rather than written when the facts were at
 * hand.
 *
 * The failure mode is not malice or haste: this repo releases by bumping `package.json` in its own
 * commit and moving a tag (`90de4be` = `chore(release): 0.7.0`, touching `package.json` and nothing
 * else). Nothing in that path ever reads the CHANGELOG, so omitting it costs nothing at the moment
 * it is omitted and costs a forensic reconstruction later.
 *
 * The invariant is NOT "the bump commit touched the changelog" — it is that the version about to be
 * tagged appears as its own heading. A step that must be remembered is the step that gets skipped;
 * this makes it fail instead.
 *
 * Dependency-free on purpose: a release gate that needs an install to run is a gate that stops
 * running.
 *
 *   node scripts/assert-changelog-version.js        # version from package.json
 *   node scripts/assert-changelog-version.js 0.9.0  # or an explicit version
 */

const fs = require('fs');
const path = require('path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const CHANGELOG_PATH = path.join(__dirname, '..', 'CHANGELOG.md');

function fail(msg) {
  console.error(`assert-changelog-version: FAIL — ${msg}`);
  process.exit(1);
}

/**
 * Headings that count as "this version is documented".
 * A heading may carry a trailing note (e.g. "## 0.4.0 — yanked"), so the version is matched at a
 * word boundary rather than requiring the line to be exactly the version.
 */
function headingNamesVersion(line, version) {
  if (!/^##\s+/.test(line)) return false;
  const rest = line.replace(/^##\s+/, '').trim();
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^v?${esc}(\\b|$)`).test(rest);
}

function main(argv) {
  if (!fs.existsSync(CHANGELOG_PATH)) fail(`CHANGELOG.md not found at ${CHANGELOG_PATH}`);

  let version = argv[0];
  if (!version) {
    if (!fs.existsSync(PKG_PATH)) fail(`package.json not found at ${PKG_PATH}`);
    try {
      version = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version;
    } catch (err) {
      fail(`package.json is not readable JSON: ${err.message}`);
    }
  }
  version = typeof version === 'string' ? version.trim().replace(/^v/, '') : '';
  if (!version) fail('no version to check (package.json has none, and none was passed)');

  const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').split('\n');
  const headings = lines.filter((l) => /^##\s+/.test(l));
  if (headings.length === 0) fail('CHANGELOG.md has no "## " headings at all');

  const match = headings.find((l) => headingNamesVersion(l, version));
  if (!match) {
    const listed = headings.slice(0, 4).map((h) => h.replace(/^##\s+/, '').trim());
    fail(
      `package.json is ${version} but CHANGELOG.md has no "## ${version}" heading.\n`
      + `  Top headings are: ${listed.join(' · ')}\n`
      + '  Tagging now is how a version goes undocumented — v0.5.0, v0.6.0 and v0.7.0 already did.\n'
      + `  Add the ${version} section, then tag.`,
    );
  }

  // "Unreleased" must never be the section that documents the version being tagged.
  if (/^##\s+unreleased\b/i.test(match)) {
    fail(`the section naming ${version} is the Unreleased heading — retitle it before tagging`);
  }

  console.log(`assert-changelog-version: OK — ${version} is documented ("${match.trim()}")`);
}

main(process.argv.slice(2));
