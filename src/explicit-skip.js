/**
 * EXPLICIT SKIP DETECTION — three carriers, one answer, no honouring.
 *
 * This module only DETECTS. It never decides to skip, because on the enforcing path the answer
 * to "please skip" is always no; what varies is only whether anyone asked. Keeping detection
 * pure is what lets the refusal be tested without a GitHub event, a repository, or a network.
 *
 * The carriers are the three places a person can put the request:
 *   1. the PR title           — visible, reviewable, and the one people reach for first
 *   2. a commit message       — survives a title edit, so a title-only check is bypassable
 *   3. CODERIFTS_SKIP in env  — the workflow-level lever, set by whoever edits the YAML
 *
 * All three are reported, not just the first. A run that names every carrier tells the author
 * what to remove; a run that names one sends them round the loop again.
 */
'use strict';

/**
 * `[skip coderifts]`, and the spellings someone will actually type. Deliberately NOT anchored:
 * the marker is valid anywhere in the text, which is how the convention works elsewhere (GitHub's
 * own `[skip ci]`). Case-insensitive, and the separator may be a space, hyphen or underscore.
 */
const SKIP_MARKER = /\[\s*skip[ _-]+coderifts\s*\]/i;

/**
 * Only an explicit, affirmative value counts. An unset variable is not a request, and neither is
 * an empty string, 'false', '0', or 'no' — CI systems set variables to those to mean OFF, and
 * reading OFF as "skip requested" would fail a build that asked for nothing.
 *
 * ⚠ The asymmetry is deliberate: everywhere else in this action an ambiguous value is read the
 * SAFE way, and safe means "keep gating". Here the safe reading is the same one — when in doubt,
 * no skip was requested, so the gate simply runs normally.
 */
const OFF_VALUES = new Set(['', 'false', '0', 'no', 'off']);

function envRequestsSkip(value) {
  if (value === undefined || value === null) return false;
  return !OFF_VALUES.has(String(value).trim().toLowerCase());
}

/**
 * @param {object} o
 * @param {string}   [o.prTitle]         pull_request.title from the event payload
 * @param {string[]} [o.commitMessages]  full messages for base..head
 * @param {object}   [o.env]             process.env (or a fixture)
 * @returns {{ requested: boolean, sources: string[], detail: string[] }}
 */
function detectExplicitSkip({ prTitle = '', commitMessages = [], env = {} } = {}) {
  const sources = [];
  const detail = [];

  if (SKIP_MARKER.test(String(prTitle || ''))) {
    sources.push('pr_title');
    detail.push('the pull request title carries the skip marker');
  }

  const hits = (commitMessages || []).filter((m) => SKIP_MARKER.test(String(m || '')));
  if (hits.length) {
    sources.push('commit_message');
    detail.push(`${hits.length} commit message(s) in this range carry the skip marker`);
  }

  if (envRequestsSkip(env.CODERIFTS_SKIP)) {
    sources.push('env_CODERIFTS_SKIP');
    // The VALUE is not echoed. It is someone's free text on a public log line.
    detail.push('CODERIFTS_SKIP is set to an affirmative value in the job environment');
  }

  return { requested: sources.length > 0, sources, detail };
}

/**
 * Commit messages for base..head, via the injectable git used everywhere else in this action.
 * Returns [] rather than throwing: a range git cannot read is not a skip request, and failing
 * the run here would turn a detection helper into a new outage surface.
 */
function commitMessagesInRange({ baseRef, headRef, cwd, gitImpl }) {
  try {
    const out = gitImpl(['log', '--format=%B%x00', `${baseRef}..${headRef}`], cwd);
    return String(out || '').split('\0').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = { detectExplicitSkip, commitMessagesInRange, SKIP_MARKER };
