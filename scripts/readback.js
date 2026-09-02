#!/usr/bin/env node
'use strict';

/**
 * Readback: who actually satisfies the required check on a pull request.
 *
 * READ-ONLY. This never writes branch protection, never posts a check, and never merges.
 *
 * WHY IT EXISTS — measured on coderifts/demo on 2026-09-01. Branch protection required the
 * context "CodeRifts / contract-gate" with `app_id: null`, which is name-only matching: the API
 * records no app binding, so ANY poster whose check-run carries that name satisfies the
 * requirement. The same PR head carried three check-runs from two different apps. Reading the
 * checks list in the UI does not show you which app posted which name, so a required check can be
 * green because something other than the gate said so, and nothing in the UI says otherwise.
 *
 * The output separates two questions that look like one:
 *   1. is the required context green?          (what branch protection asks)
 *   2. did the gate post the check that made it green?  (what you probably meant)
 *
 * Usage:
 *   node scripts/readback.js <owner/repo> <pr-number> [--expect-app <slug>]
 *   GITHUB_TOKEN=... node scripts/readback.js coderifts/demo 4 --expect-app coderifts
 */

const DEFAULT_API = 'https://api.github.com';

/**
 * Statuses a required context can be in. INDETERMINATE is deliberately distinct from ABSENT:
 * "nobody posted it" and "several posted it and we cannot tell which one counted" are different
 * problems, and collapsing them hides the second.
 */
const READBACK = Object.freeze({
  EXACT: 'EXACT',
  INDETERMINATE: 'INDETERMINATE',
  ABSENT: 'ABSENT',
});

/**
 * Pure analysis over shapes the API already returns — no I/O, so the fixture test drives the real
 * decision rather than a mock of it.
 *
 * @param {object} o
 * @param {object} o.protection   GET /repos/{o}/{r}/branches/{b}/protection
 * @param {Array}  o.checkRuns    GET /repos/{o}/{r}/commits/{sha}/check-runs -> .check_runs
 * @param {string} [o.expectApp]  app slug the gate posts under (e.g. 'github-actions' for the Action)
 */
function analyzeReadback({ protection, checkRuns, expectApp = null }) {
  const rsc = (protection && protection.required_status_checks) || null;
  // `checks[]` carries the app binding; `contexts[]` is the older name-only list. Prefer checks[].
  const required = rsc && Array.isArray(rsc.checks) && rsc.checks.length > 0
    ? rsc.checks.map((c) => ({ context: c.context, app_id: c.app_id == null ? null : c.app_id }))
    : ((rsc && Array.isArray(rsc.contexts) ? rsc.contexts : []).map((c) => ({ context: c, app_id: null })));

  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const rows = required.map(({ context, app_id }) => {
    const posted = runs.filter((r) => r && r.name === context);
    const posters = posted.map((r) => ({
      app_slug: (r.app && r.app.slug) || null,
      app_id: (r.app && r.app.id) != null ? r.app.id : null,
      conclusion: r.conclusion || null,
    }));

    let status;
    if (posted.length === 0) status = READBACK.ABSENT;
    else if (posted.length > 1) status = READBACK.INDETERMINATE;
    else status = READBACK.EXACT;

    // Source binding is what makes the answer decidable at all. app_id null = name-only.
    const bound_to_source = app_id != null;
    const expectedPosted = expectApp == null
      ? null
      : posters.some((p) => p.app_slug === expectApp);

    return {
      context,
      bound_to_source,
      bound_app_id: app_id,
      status,
      posters,
      green: posted.some((r) => r.conclusion === 'success'),
      posted_by_expected_app: expectedPosted,
    };
  });

  return {
    enforce_admins: !!(protection && protection.enforce_admins && protection.enforce_admins.enabled),
    strict_up_to_date: !!(rsc && rsc.strict),
    required: rows,
    // Every required context that a party other than the gate could satisfy by name alone.
    name_only_contexts: rows.filter((r) => !r.bound_to_source).map((r) => r.context),
  };
}


/**
 * ── 1262: THE PRODUCER ─────────────────────────────────────────────────────────────────────
 *
 * `provider-enforcement-result.v1` had a schema and a hand-written example and no producer, so
 * the one document that states what a provider actually enforces was the one document nobody
 * measured. `--result` fills it from a LIVE read: the branch-protection API, the head check
 * rollup, and this run's own analysis.
 *
 * WHAT IS MEASURED HERE AND WHAT IS CARRIED. `mode`, `required_check`, `readback` and
 * `bypass_policy` are read from the API on this run — change the repository and they change.
 * `negative_test` cannot be: it is a destructive procedure (POST a check-run as a user, attempt a
 * merge) that a read-only producer must not perform. It is carried from a recorded observation,
 * and it carries the DATE it was observed so a reader can judge how stale it is. A producer that
 * silently emitted `PASSED` for a test it never ran would be the exact failure this schema exists
 * to prevent.
 */

/** The recorded negative test. Not measured by this run — see the note above. */
const NEGATIVE_TEST = Object.freeze({
  status: 'PASSED',
  observed_at: '2026-09-02T00:00:00Z',
  procedure:
    'Two attempts, both refused. (1) A USER token POSTed a check-run under the required context '
    + 'name to the PR head — GitHub answered 403 (only a GitHub App may create check runs), so a '
    + 'party other than the bound App cannot satisfy the check by name. (2) With the required '
    + 'check unsatisfied, the PR reported mergeStateStatus BLOCKED and the merge button was '
    + 'unavailable. Recorded rather than re-run: both steps mutate a real repository, which a '
    + 'read-only producer must not do.',
});

function statementFor({ hasRequirement, exact, boundAll, enforceAdmins }) {
  // TWO DIFFERENT NOTHINGS. "no requirement configured" and "a requirement anyone can satisfy"
  // both grade mode:none, and collapsing them would tell an operator with a name-only check that
  // they have no check at all — which is not what they need to fix.
  if (!hasRequirement) {
    return 'No required check is configured on the base branch, so nothing at the provider '
      + 'prevents a merge. Whatever the gate reports, it reports it beside an open door.';
  }
  const parts = [];
  parts.push(exact
    ? 'Every required context was satisfied by exactly one check run, so the readback is EXACT: '
      + 'the run that satisfied the requirement is identifiable.'
    : 'At least one required context was satisfied by zero or by several runs, so the readback is '
      + 'not EXACT and the satisfying run is not identifiable.');
  parts.push(boundAll
    ? 'Every required context is bound to a source app id, so it cannot be satisfied by name '
      + 'alone.'
    : 'At least one required context is name-only: any party that can post a check with that name '
      + 'satisfies it.');
  parts.push(enforceAdmins
    ? 'enforce_admins is on, so administrators are subject to the same requirement.'
    : 'enforce_admins is OFF — an administrator can merge past the requirement, which is a bypass '
      + 'the check itself cannot see.');
  return parts.join(' ');
}

/**
 * Build a provider-enforcement-result.v1 document from a live readback.
 * Pure over the analysis output, so the fixture test drives the real construction.
 */
function buildResult(analysis, { expectApp = null } = {}) {
  const rows = analysis.required || [];
  const primary = (expectApp && rows.find((r) => r.posted_by_expected_app)) || rows[0] || null;
  const mode = rows.length === 0
    ? 'none'
    : (primary && primary.bound_to_source ? 'app' : 'none');
  const exact = rows.length > 0 && rows.every((r) => r.status === READBACK.EXACT);
  const boundAll = rows.length > 0 && rows.every((r) => r.bound_to_source);

  return {
    provider: 'github',
    mode,
    required_check: {
      name: primary ? primary.context : null,
      // The whole decidability question: a name-only requirement is satisfiable by anyone.
      bound_to_source: primary ? primary.bound_to_source : false,
      bound_app_id: primary ? primary.bound_app_id : null,
      posters: primary ? primary.posters : [],
    },
    readback: {
      status: rows.length === 0
        ? READBACK.ABSENT
        : (exact ? READBACK.EXACT : (rows.some((r) => r.status === READBACK.ABSENT)
          ? READBACK.ABSENT : READBACK.INDETERMINATE)),
      evidence: rows.length === 0
        ? 'no required status checks are configured on the base branch'
        : rows.map((r) => `${r.context}: ${r.status}`
            + `, bound_app_id=${r.bound_app_id == null ? 'null (name-only)' : r.bound_app_id}`
            + `, posters=[${r.posters.map((x) => `${x.app_slug || '?'}#${x.app_id == null ? '?' : x.app_id}`).join(', ')}]`)
          .join('; '),
    },
    negative_test: { ...NEGATIVE_TEST },
    bypass_policy: {
      enforce_admins: !!analysis.enforce_admins,
      strict_up_to_date: !!analysis.strict_up_to_date,
    },
    statement: statementFor({
      hasRequirement: rows.length > 0,
      exact,
      boundAll,
      enforceAdmins: !!analysis.enforce_admins,
    }),
    // Named, never omitted: a reader must not infer these from silence.
    not_implemented:
      'This document describes GitHub only. GitLab and Bitbucket have no native identity binding '
      + 'for a check result, so an equivalent document for them would report mode "none" — the '
      + 'CodeRifts layer there is NOT_VERIFIED provider-side.',
  };
}

function render(result) {
  const out = [];
  out.push(`enforce_admins: ${result.enforce_admins}   strict (up-to-date): ${result.strict_up_to_date}`);
  if (result.required.length === 0) out.push('no required status checks on this branch');
  for (const r of result.required) {
    out.push('');
    out.push(`required context: ${JSON.stringify(r.context)}`);
    out.push(`  source-bound:   ${r.bound_to_source ? `yes (app_id ${r.bound_app_id})` : 'NO — name-only match'}`);
    out.push(`  readback:       ${r.status}${r.green ? ' (green)' : ''}`);
    if (r.posters.length === 0) out.push('  posted by:      nobody');
    for (const p of r.posters) {
      out.push(`  posted by:      ${p.app_slug || 'unknown'} (app_id ${p.app_id == null ? 'null' : p.app_id}) -> ${p.conclusion}`);
    }
    if (r.posted_by_expected_app === false) {
      out.push('  NOTE:           the expected app did not post this context');
    }
  }
  if (result.name_only_contexts.length > 0) {
    out.push('');
    out.push('Name-only contexts can be satisfied by any poster using that name:');
    for (const c of result.name_only_contexts) out.push(`  - ${c}`);
  }
  return out.join('\n');
}

async function fetchReadback({ owner, repo, pr, token, expectApp, apiUrl = DEFAULT_API, fetchImpl = fetch }) {
  const get = async (path) => {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'coderifts-contract-gate-readback',
      },
    });
    if (!res || res.status < 200 || res.status >= 300) {
      throw new Error(`GET ${path} -> HTTP ${res ? res.status : 'no response'}`);
    }
    return res.json();
  };

  const prData = await get(`/repos/${owner}/${repo}/pulls/${pr}`);
  const headSha = prData.head && prData.head.sha;
  const baseRef = prData.base && prData.base.ref;
  if (!headSha || !baseRef) throw new Error('could not read PR head sha / base ref');

  const protection = await get(`/repos/${owner}/${repo}/branches/${baseRef}/protection`);
  const runs = await get(`/repos/${owner}/${repo}/commits/${headSha}/check-runs`);
  return {
    headSha,
    baseRef,
    ...analyzeReadback({ protection, checkRuns: runs.check_runs, expectApp }),
  };
}

async function main(argv) {
  const emitResult = argv.includes('--result');
  const positional = argv.filter((a) => a !== '--result');
  const [slug, pr] = positional;
  const expectIdx = positional.indexOf('--expect-app');
  const expectApp = expectIdx !== -1 ? positional[expectIdx + 1] : null;
  if (!slug || !pr || !slug.includes('/')) {
    console.error(
      'usage: node scripts/readback.js <owner/repo> <pr-number> [--expect-app <slug>] [--result]\n'
      + '  --result  emit a provider-enforcement-result.v1 JSON document on stdout',
    );
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error('readback: GITHUB_TOKEN (or GH_TOKEN) is required — this reads protected-branch settings');
    process.exit(2);
  }
  const [owner, repo] = slug.split('/');
  try {
    const result = await fetchReadback({ owner, repo, pr, token, expectApp });
    if (emitResult) {
      // stdout stays a clean JSON document for a pipe; provenance goes to stderr.
      process.stderr.write(
        `measured ${slug} PR #${pr} head ${result.headSha} base ${result.baseRef}\n`,
      );
      console.log(JSON.stringify(buildResult(result, { expectApp }), null, 2));
      return;
    }
    console.log(`repo ${slug}  PR #${pr}  head ${result.headSha}  base ${result.baseRef}`);
    console.log(render(result));
  } catch (err) {
    console.error(`readback: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { analyzeReadback, render, fetchReadback, buildResult, statementFor, NEGATIVE_TEST, READBACK };
