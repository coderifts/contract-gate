/**
 * VENDORED MIRROR of @coderifts/contract-path@1.0.0 (coderifts-app/packages/contract-path).
 *
 * That package's own header says: "Gate-path contract-file classifier (single list) … Do not
 * invent a second glob/list." This file is NOT a second list — it is a byte-faithful copy of the
 * one list, kept honest by test/contract-path-mirror.test.js, which classifies a corpus through
 * BOTH this copy and the real package and asserts identical answers. If they ever diverge, the
 * suite fails.
 *
 * WHY VENDORED RATHER THAN DEPENDED ON: this repo is a GitHub Action with
 * `using: node20, main: src/index.js`. Actions do not run `npm install` at dispatch, and this
 * repo does not commit node_modules (.gitignore). A runtime dependency would therefore have to be
 * committed or bundled — a packaging change to a published Action. Same trade-off, and same
 * mitigation (a drift test), as the scope-hash mirror in grant-coverage.js.
 */
'use strict';

const CONTRACT_EXT = /\.(ya?ml|json|graphql|gql|proto)$/i;

function looksLikeContractPath(p) {
  const s = String(p || '').toLowerCase();
  if (s.includes('node_modules/') || s.includes('vendor/')) return false;
  return CONTRACT_EXT.test(s) && (s.includes('openapi') || s.includes('swagger') || s.includes('asyncapi')
    || s.endsWith('.graphql') || s.endsWith('.gql') || s.endsWith('.proto') || s.includes('mcp'));
}

function typeForPath(p) {
  const s = String(p).toLowerCase();
  if (s.endsWith('.graphql') || s.endsWith('.gql')) return 'graphql';
  if (s.endsWith('.proto')) return 'grpc';
  if (s.includes('asyncapi')) return 'asyncapi';
  if (s.includes('mcp')) return 'mcp_manifest';
  return 'openapi';
}

module.exports = { CONTRACT_EXT, looksLikeContractPath, typeForPath };
