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
/**
 * 1329 — RULESETS are a SECOND, INDEPENDENT source of the same requirement.
 *
 * MEASURED live on coderifts/demo 2026-09-03. This producer read branch protection and check-runs
 * and never called the rulesets API — so it could not see the binding that actually gates main:
 *
 *   ruleset 22074842 "coderifts-enforcement" (active, bypass_actors: [])
 *     required_status_checks: [{ context: "CodeRifts / contract-gate (Action)", integration_id: 15368 }]
 *
 * A repository can carry BOTH classic branch protection and one or more rulesets, and the rules
 * are the UNION. A readback that reads only protection therefore reports on a requirement that may
 * not be the one blocking the merge — the exact class of error this file exists to catch, one
 * layer up from where it was looking.
 *
 * THE THIRD STATE IS NOT OPTIONAL HERE. The rulesets API needs permissions this token may not
 * carry, and `GET /repos/{o}/{r}/rules/branch/{b}` returned 404 under a token that could still
 * read `/rulesets`. An unreadable rulesets API must therefore be UNREADABLE, never "no rulesets" —
 * collapsing them would report a repository with an active blocking ruleset as unbound.
 */
const RULESETS = Object.freeze({
  BOUND: 'BOUND',            // a ruleset requires the context AND names an integration_id
  NAME_ONLY: 'NAME_ONLY',    // a ruleset requires the context with no integration_id
  ABSENT: 'ABSENT',          // rulesets were read and none requires this context
  UNREADABLE: 'UNREADABLE',  // the API could not be read — NOT the same as ABSENT
});

/**
 * Fold ruleset documents into the same shape `required` uses, so both sources are comparable.
 *
 * @param {Array|null} rulesets  expanded ruleset documents (with `.rules`), or null if unreadable
 * @returns {{ status: string, reason: string|null, requirements: Array }}
 */
function analyzeRulesets(rulesets) {
  if (rulesets == null) {
    return {
      status: RULESETS.UNREADABLE,
      reason: 'the rulesets API was not read (missing permission, or the call failed) — this is '
        + 'NOT evidence that no ruleset requires the check',
      requirements: [],
    };
  }
  const list = Array.isArray(rulesets) ? rulesets : [];
  const requirements = [];
  for (const rs of list) {
    if (!rs || typeof rs !== 'object') continue;
    // Only an ACTIVE ruleset gates a merge. `evaluate` and `disabled` are recorded, not counted.
    const active = rs.enforcement === 'active';
    for (const rule of (Array.isArray(rs.rules) ? rs.rules : [])) {
      if (!rule || rule.type !== 'required_status_checks') continue;
      const params = rule.parameters || {};
      for (const c of (Array.isArray(params.required_status_checks) ? params.required_status_checks : [])) {
        requirements.push({
          ruleset_id: rs.id == null ? null : rs.id,
          ruleset_name: rs.name || null,
          enforcement: rs.enforcement || null,
          active,
          context: c && c.context ? c.context : null,
          // The field the auditors asked about: WHICH issuer may satisfy this requirement.
          integration_id: c && c.integration_id != null ? c.integration_id : null,
          // A bypass list is what turns an "active" ruleset into an advisory one.
          bypass_actor_count: Array.isArray(rs.bypass_actors) ? rs.bypass_actors.length : null,
        });
      }
    }
  }
  const active = requirements.filter((r) => r.active);
  if (active.length === 0) return { status: RULESETS.ABSENT, reason: null, requirements };
  const anyUnbound = active.some((r) => r.integration_id == null);
  return {
    status: anyUnbound ? RULESETS.NAME_ONLY : RULESETS.BOUND,
    reason: null,
    requirements,
  };
}

/**
 * Cross-check: does the ruleset's binding agree with who ACTUALLY posted?
 * Returns rows, never a single verdict — a repository may carry several requirements.
 */
function crossCheckRulesets(rulesetAnalysis, checkRuns) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  return (rulesetAnalysis.requirements || []).filter((r) => r.active).map((r) => {
    const posted = runs.filter((x) => x && x.name === r.context);
    const posterAppIds = [...new Set(posted.map((x) => (x.app && x.app.id) != null ? x.app.id : null))];
    return {
      context: r.context,
      integration_id: r.integration_id,
      posted_count: posted.length,
      poster_app_ids: posterAppIds,
      // THREE outcomes, and "nobody posted it" is its own. A required context nothing produces is
      // a permanently-pending gate, which looks like enforcement and is not.
      agreement: posted.length === 0
        ? 'NOTHING_POSTED_THIS_CONTEXT'
        : (r.integration_id != null && posterAppIds.includes(r.integration_id)
          ? 'BOUND_ISSUER_POSTED'
          : 'POSTED_BY_OTHER_ISSUER'),
    };
  });
}

function analyzeReadback({ protection, checkRuns, expectApp = null, rulesets = undefined }) {
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

  // 1329 — the rulesets source, folded in beside protection. `undefined` means the caller did not
  // ask (older callers stay byte-identical); `null` means it was asked for and could not be read.
  const rulesetAnalysis = rulesets === undefined
    ? { status: RULESETS.UNREADABLE, reason: 'caller did not request rulesets', requirements: [] }
    : analyzeRulesets(rulesets);
  const rulesetCrossCheck = crossCheckRulesets(rulesetAnalysis, checkRuns);

  return {
    enforce_admins: !!(protection && protection.enforce_admins && protection.enforce_admins.enabled),
    strict_up_to_date: !!(rsc && rsc.strict),
    required: rows,
    // Every required context that a party other than the gate could satisfy by name alone.
    name_only_contexts: rows.filter((r) => !r.bound_to_source).map((r) => r.context),
    // 1329 — the SECOND source of the same requirement. Rules are the union of protection and
    // rulesets, so a readback that reports only the first can describe a requirement that is not
    // the one gating the merge.
    rulesets: rulesetAnalysis,
    ruleset_cross_check: rulesetCrossCheck,
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

/**
 * 1338 — THE STATEMENT READ THE WRONG SOURCE.
 *
 * MEASURED on coderifts/demo 2026-09-03, after classic branch protection was deleted: this
 * producer reported `readback.status: ABSENT` and the statement "nothing at the provider prevents
 * a merge … beside an open door", WHILE the `ruleset_binding` block in the same document reported
 * BOUND with integration_id 2860592 and BOUND_ISSUER_POSTED. One document, two contradictory
 * answers about the same repository.
 *
 * The cause: `rows` comes from classic `branches/main/protection` only. The schema's own
 * description already says the right rule — "a repository's rules are the UNION of branch
 * protection and any active rulesets, so a document that reports only the first can describe a
 * requirement that is not the one gating the merge". The producer did not follow it.
 *
 * SO: the absence of classic protection is no longer "open door" when a ruleset binds. Classic
 * protection stays a source, and remains the one that carries `enforce_admins` — a ruleset's
 * bypass actors are a different mechanism and are reported separately, never folded in as if they
 * were the same thing.
 *
 * @param {object} o
 * @param {boolean} o.hasRequirement   a CLASSIC required context exists
 * @param {string}  o.rulesetStatus    BOUND | NAME_ONLY | ABSENT | UNREADABLE
 */
function statementFor({ hasRequirement, exact, boundAll, enforceAdmins, rulesetStatus }) {
  const rulesetRequires = rulesetStatus === RULESETS.BOUND || rulesetStatus === RULESETS.NAME_ONLY;

  // TWO DIFFERENT NOTHINGS. "no requirement configured" and "a requirement anyone can satisfy"
  // both grade mode:none, and collapsing them would tell an operator with a name-only check that
  // they have no check at all — which is not what they need to fix.
  if (!hasRequirement && !rulesetRequires) {
    // A THIRD nothing, and it is not the same as the other two: we may simply not have been able
    // to look. Saying "open door" on an unread rulesets API would be the exact overclaim in the
    // opposite direction.
    if (rulesetStatus === RULESETS.UNREADABLE) {
      return 'No required check is configured on the base branch, AND the rulesets API could not '
        + 'be read — so whether anything at the provider prevents a merge is UNDECIDED here. This '
        + 'is not evidence of an open door; it is evidence that one of the two sources was not '
        + 'readable.';
    }
    return 'No required check is configured on the base branch and no active ruleset requires one, '
      + 'so nothing at the provider prevents a merge. Whatever the gate reports, it reports it '
      + 'beside an open door.';
  }

  // A ruleset binds and classic protection is empty. This is the state that used to be reported as
  // an open door, and it is the opposite of one.
  if (!hasRequirement) {
    const bindingSentence = rulesetStatus === RULESETS.BOUND
      ? 'The ruleset names an integration_id, so the requirement cannot be satisfied by name alone.'
      : 'The ruleset requirement is NAME-ONLY: any party that can post a check with that name '
        + 'satisfies it.';
    // Kept under the schema's 400-character statement limit, measured: the first draft was 416.
    // What was cut is the enforce_admins explanation, which belongs to bypass_policy and
    // ruleset_binding rather than to a sentence a reader skims.
    return 'No classic branch protection is configured, but an ACTIVE RULESET requires the check, '
      + `so the provider does gate the merge. ${bindingSentence} `
      + 'enforce_admins is a classic-protection field: for a ruleset-only repository see the '
      + 'per-requirement bypass actors in ruleset_binding.';
  }
  const parts = [];
  if (rulesetRequires) {
    // Both sources require it — an operator who removes one still has the other.
    //
    // MEASURED: the statement has a 400-character schema limit and the longest existing
    // combination is 358, so this sentence gets 42 characters. It is deliberately the shortest of
    // the four because it is the least actionable: the three below tell an operator what to fix,
    // this one tells them a removal will not open the door. The detail is in ruleset_binding.
    // test/readback.test.js holds the limit across every branch so a future edit cannot overflow it.
    parts.push('Classic protection AND a ruleset apply.');
  }
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

  // 1338 — the SECOND source of the same requirement, read ONCE here and used by `mode`, the
  // statement and the readback block, all three of which used to read classic protection alone.
  // Defaults to UNREADABLE rather than ABSENT: not having been told is not the same as having
  // looked and found nothing.
  const rulesetStatusForDoc = (analysis.rulesets && analysis.rulesets.status) || RULESETS.UNREADABLE;
  const rulesetRequires = rulesetStatusForDoc === RULESETS.BOUND
    || rulesetStatusForDoc === RULESETS.NAME_ONLY;

  // 1338 — `mode` read classic protection alone too, and it is the THIRD place the same mistake
  // lived. The schema defines 'app' as "a check-run from an app installation" binds the verdict,
  // and 'none' as "nothing binds it". A ruleset that names an integration_id binds it exactly the
  // way classic protection with an app_id does; reporting 'none' there says the opposite of what
  // was measured two fields below in ruleset_binding.
  //
  // NAME_ONLY stays 'none' on purpose: a requirement anyone can satisfy binds nothing to a source,
  // whichever of the two mechanisms carries it.
  const mode = rows.length > 0
    ? (primary && primary.bound_to_source ? 'app' : 'none')
    : (rulesetStatusForDoc === RULESETS.BOUND ? 'app' : 'none');

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
    // 1329 — the ruleset binding, in the result document rather than only in the console render.
    // `status: UNREADABLE` is a real value here: a consumer must be able to tell "no ruleset
    // requires this" from "we could not look".
    ruleset_binding: {
      status: (analysis.rulesets && analysis.rulesets.status) || 'UNREADABLE',
      reason: (analysis.rulesets && analysis.rulesets.reason) || null,
      requirements: (analysis.rulesets && analysis.rulesets.requirements) || [],
      cross_check: analysis.ruleset_cross_check || [],
    },
    readback: {
      // 1338: ABSENT means "nothing requires this", which is a claim about the UNION. With no
      // classic protection but a binding ruleset the honest answer is INDETERMINATE from this
      // block's point of view — it reads check runs against classic contexts and has none to
      // read — and ruleset_binding above carries the decided answer. Reporting ABSENT here was
      // the half of the contradiction that a reader saw first.
      status: rows.length === 0
        ? (rulesetRequires ? READBACK.INDETERMINATE : READBACK.ABSENT)
        : (exact ? READBACK.EXACT : (rows.some((r) => r.status === READBACK.ABSENT)
          ? READBACK.ABSENT : READBACK.INDETERMINATE)),
      evidence: rows.length === 0
        ? (rulesetRequires
          ? 'no CLASSIC required status checks are configured; the requirement comes from an '
            + `active ruleset (${rulesetStatusForDoc}) — see ruleset_binding for the bound issuer `
            + 'and whether it posted'
          : 'no required status checks are configured on the base branch, and no active ruleset '
            + 'requires one')
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
      rulesetStatus: rulesetStatusForDoc,
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

  // 1329 — CLASSIC BRANCH PROTECTION MAY NOT EXIST, and its absence is not an error.
  //
  // MEASURED live on coderifts/demo 2026-09-03: after the rebind moved the requirement into the
  // RULESET and classic protection was deleted, this call returns 404 "Branch not protected" and
  // the whole producer died on it — emitting nothing for a repository whose ruleset is active,
  // bound and gating. A readback that cannot describe the modern configuration is worse than one
  // that describes it partially.
  //
  // 404 → `null` (no classic protection; rulesets may still gate). Any OTHER status still throws:
  // a 403 means we could not look, and reporting that as "no protection" would be the same
  // absence-vs-unreadable collapse this file refuses everywhere else.
  let protection = null;
  try {
    protection = await get(`/repos/${owner}/${repo}/branches/${baseRef}/protection`);
  } catch (err) {
    if (!/-> HTTP 404$/.test(String(err && err.message))) throw err;
    protection = null;
  }
  const runs = await get(`/repos/${owner}/${repo}/commits/${headSha}/check-runs`);

  // 1329 — rulesets, read separately and FAIL-SOFT TO null (never to []). The list endpoint
  // returns summaries without `rules`, so each ruleset is expanded; a ruleset that cannot be
  // expanded is dropped from the list AND forces the whole read to UNREADABLE, because a partial
  // list would under-report the binding while looking complete.
  let rulesets = null;
  try {
    const summaries = await get(`/repos/${owner}/${repo}/rulesets`);
    const expanded = [];
    for (const rs of (Array.isArray(summaries) ? summaries : [])) {
      if (!rs || rs.id == null) continue;
      expanded.push(await get(`/repos/${owner}/${repo}/rulesets/${rs.id}`));
    }
    rulesets = expanded;
  } catch (_) {
    rulesets = null; // named UNREADABLE downstream — not "no rulesets"
  }

  return {
    headSha,
    baseRef,
    ...analyzeReadback({ protection, checkRuns: runs.check_runs, expectApp, rulesets }),
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

module.exports = {
  analyzeReadback, render, fetchReadback, buildResult, statementFor,
  analyzeRulesets, crossCheckRulesets, NEGATIVE_TEST, READBACK, RULESETS,
};
