'use strict';

/**
 * Derive the contract change set from the PR's ACTUAL head diff — NOT from any caller input.
 *
 * This is the anti-bypass core (Gap 5). An agent could otherwise submit the unchanged base spec to
 * get a clean receipt while merging something breaking. Here the artifacts are read straight from
 * git: the changed files between base and head, with before = base blob, after = head blob. There is
 * no code path that accepts caller-supplied artifacts.
 */

const { execFileSync } = require('node:child_process');

// changed-file path -> preflight artifact type. Conservative + explicit; a file that matches nothing
// is not a governed contract artifact and is ignored (it never changed a contract surface).
const CLASSIFIERS = [
  { type: 'openapi', re: /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i },
  { type: 'openapi', re: /(^|\/)[^/]*-api\.(ya?ml|json)$/i },
  { type: 'openapi', re: /(^|\/)api\/[^/]*\.(ya?ml|json)$/i },
  { type: 'asyncapi', re: /(^|\/)asyncapi[^/]*\.(ya?ml|json)$/i },
  { type: 'graphql', re: /\.(graphql|gql)$/i },
  { type: 'grpc', re: /\.proto$/i },
  { type: 'mcp_manifest', re: /(^|\/)(mcp[^/]*\.json|tools?-catalog\.json|mcp-manifest\.json)$/i },
];

function classify(path) {
  for (const c of CLASSIFIERS) {
    if (c.re.test(path)) return c.type;
  }
  return null;
}

/** Default git runner: argv form (never a shell string) so a path can never become a command. */
function defaultGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Read the blob at <ref>:<path>. Returns '' when the file does not exist at that ref (added on head /
 * deleted on head), matching preflight's before/after-empty convention.
 */
function blobAt(ref, path, cwd, gitImpl) {
  try {
    return gitImpl(['show', `${ref}:${path}`], cwd);
  } catch (_) {
    return '';
  }
}

/**
 * @param {object} o
 * @param {string} o.baseRef   base commit/ref (PR target)
 * @param {string} o.headRef   head commit/ref (PR source — the ACTUAL merge candidate)
 * @param {string} [o.cwd]     repo working directory
 * @param {(args:string[],cwd:string)=>string} [o.gitImpl]  injectable git (tests)
 * @returns {{ artifacts: Array<{id,type,before,after}>, changedContractFiles: string[], allChanged: string[] }}
 */
function deriveArtifactsFromDiff({ baseRef, headRef, cwd = process.cwd(), gitImpl = defaultGit }) {
  if (!baseRef || !headRef) throw new Error('deriveArtifactsFromDiff: baseRef and headRef are required');

  // Three-dot: files changed on head since the merge-base with base — i.e. exactly the PR's changes.
  const out = gitImpl(['diff', '--name-only', `${baseRef}...${headRef}`], cwd);
  const allChanged = out.split('\n').map((s) => s.trim()).filter(Boolean);

  const artifacts = [];
  const changedContractFiles = [];
  for (const path of allChanged) {
    const type = classify(path);
    if (!type) continue;
    changedContractFiles.push(path);
    const before = blobAt(baseRef, path, cwd, gitImpl);
    const after = blobAt(headRef, path, cwd, gitImpl);
    // A rename/no-op with identical bytes is not a material change; skip it.
    if (before === after) continue;
    artifacts.push({ id: path, type, before, after });
  }
  return { artifacts, changedContractFiles, allChanged };
}

module.exports = { deriveArtifactsFromDiff, classify, CLASSIFIERS, blobAt, defaultGit };
