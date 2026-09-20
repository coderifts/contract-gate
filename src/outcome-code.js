/**
 * OUTCOME CODES — what this run CONCLUDED, kept apart from why a gate DENIED.
 *
 * WHY A SEPARATE NAMESPACE, and not three more entries in DENY_ERROR.
 *
 * `deny-remedy.js` owns DENY_ERROR, a set closed to three grant states and published in
 * `deny-remedy.v1.json`. Those three answer ONE question: the gate refused to authorise a change
 * set — what does the caller do about it? Each carries a remedy, an args shape, and a promise it
 * explicitly does not make.
 *
 * The codes here answer a DIFFERENT question: was a governed decision even reached, and if not,
 * why not? `NO_CONTRACT_CHANGE` is not a denial — it is a pass. `EXPLICIT_SKIP_NOT_ALLOWED` is a
 * failure that never reached a contract at all. Neither has a grant remedy, because neither is
 * about a grant.
 *
 * Folding them into DENY_ERROR would cost one of two things, and both are worse than a second
 * namespace: widen a PUBLISHED closed enum (breaking for every consumer that switches on it), or
 * describe a pass as a denial. `assertDisjoint()` below is what keeps the two sets from drifting
 * back together — it is called by the test suite, not left as a comment nobody runs.
 */
'use strict';

const OUTCOME_CODE = Object.freeze({
  /**
   * SUCCESS. The diff changed no contract artifact (openapi/graphql/grpc/asyncapi/mcp-manifest),
   * so there was nothing to govern. This is a real conclusion, not an absence of one: the job
   * RAN, looked, and found nothing governed. That distinction is the whole point — a check that
   * never ran would report nothing at all, and GitHub reads nothing as "not failing".
   */
  NO_CONTRACT_CHANGE: 'NO_CONTRACT_CHANGE',

  /**
   * FAILURE. Someone asked, in words, for this gate to stand down: `[skip coderifts]` in the PR
   * title or a commit message, or CODERIFTS_SKIP set in the job environment.
   *
   * The request is refused rather than honoured, and the refusal is a FAILURE rather than a
   * neutral, because a required check that can be waived by writing a phrase is not a required
   * check. The marker is not evidence that the change is safe; it is evidence that someone wanted
   * the question not to be asked.
   *
   * NOTE the asymmetry with the CLI's pre-push hook, where CODERIFTS_SKIP IS honoured: a local
   * hook is a convenience the author can always bypass anyway, and pretending otherwise would
   * only teach people to uninstall it. A required check is the opposite — it exists precisely to
   * be the thing that cannot be bypassed by the person being checked.
   */
  EXPLICIT_SKIP_NOT_ALLOWED: 'EXPLICIT_SKIP_NOT_ALLOWED',
});

/** Conclusion each code maps to. A code with no conclusion here is a code nobody wired up. */
const OUTCOME_CONCLUSION = Object.freeze({
  [OUTCOME_CODE.NO_CONTRACT_CHANGE]: 'success',
  [OUTCOME_CODE.EXPLICIT_SKIP_NOT_ALLOWED]: 'failure',
});

/**
 * The guard that keeps the two namespaces from quietly merging. Throws on overlap.
 * @param {Record<string,string>} denyErrors  the DENY_ERROR frozen map
 */
function assertDisjoint(denyErrors) {
  const mine = new Set(Object.values(OUTCOME_CODE));
  const theirs = Object.values(denyErrors || {});
  const shared = theirs.filter((v) => mine.has(v));
  if (shared.length) {
    throw new Error(
      `outcome-code: ${shared.join(', ')} appears in BOTH OUTCOME_CODE and DENY_ERROR. ` +
      'These namespaces answer different questions and must not share a value — see the header.'
    );
  }
  return true;
}

module.exports = { OUTCOME_CODE, OUTCOME_CONCLUSION, assertDisjoint };
