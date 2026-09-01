'use strict';

/**
 * Post a GitHub Check Run with a STABLE name so branch protection can mark it a required check
 * (R2 wires the requirement; R1 only produces the check). conclusion:'success' on pass, 'failure'
 * otherwise. Dependency-free: raw GitHub REST via fetch + GITHUB_TOKEN.
 */

// STABLE — do not change casually; branch protection references this string.
const CHECK_NAME = 'CodeRifts / contract-gate';

/**
 * @param {object} o
 * @param {string} o.token       GITHUB_TOKEN with checks:write
 * @param {string} o.owner
 * @param {string} o.repo
 * @param {string} o.headSha
 * @param {'success'|'failure'} o.conclusion
 * @param {string} o.title
 * @param {string} o.summary
 * @param {string} [o.text]      long-form body under the summary; omitted when null
 * @param {string} [o.apiUrl]    GitHub API base (default https://api.github.com)
 * @param {typeof fetch} [o.fetchImpl]
 * @returns {Promise<{ok:boolean, status:number}>}
 */
async function postCheckRun({ token, owner, repo, headSha, conclusion, title, summary, text = null, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!token) throw new Error('postCheckRun: token is required');
  if (!owner || !repo || !headSha) throw new Error('postCheckRun: owner, repo, headSha required');

  const res = await fetchImpl(`${apiUrl}/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'coderifts-contract-gate',
    },
    body: JSON.stringify({
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'completed',
      conclusion,
      output: {
        title: String(title).slice(0, 255),
        summary: String(summary).slice(0, 65000),
        // Omitted entirely when there is nothing to say — an empty `text` would
        // render as a blank section under the summary.
        ...(text ? { text: String(text).slice(0, 65000) } : {}),
      },
    }),
  });
  return { ok: !!res && res.status >= 200 && res.status < 300, status: res ? res.status : 0 };
}

module.exports = { postCheckRun, CHECK_NAME };
