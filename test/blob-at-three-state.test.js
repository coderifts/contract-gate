'use strict';

/**
 * blobAt / deriveArtifactsFromDiff three-state reads:
 * present (string, may be '') | absent (null) | unreadable (throw ARTIFACT_UNREADABLE).
 * Injectable gitImpl only — no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  blobAt,
  deriveArtifactsFromDiff,
  isPathAbsentAtRef,
} = require('../src/artifacts');

/**
 * Minimal injectable git: supports rev-parse --verify, show ref:path, and diff --name-only.
 * @param {object} opts
 * @param {Record<string, string>} [opts.blobs]  key "ref:path" → content (use '' for empty present)
 * @param {Set<string>|string[]} [opts.badRefs]  refs that fail rev-parse
 * @param {string[]} [opts.changed]  paths returned by three-dot name-only diff
 * @param {Record<string, Error>} [opts.showThrow]  force throw on show for "ref:path" after rev-parse ok
 */
function makeGitImpl({
  blobs = {},
  badRefs = [],
  changed = [],
  showThrow = {},
} = {}) {
  const bad = badRefs instanceof Set ? badRefs : new Set(badRefs);
  return (args) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const spec = String(args[2] || '');
      const ref = spec.replace(/\^{commit}$/, '');
      if (bad.has(ref)) {
        const err = new Error(`Command failed: git rev-parse --verify ${spec}`);
        err.stderr = `fatal: invalid object name '${ref}'.\n`;
        err.status = 128;
        throw err;
      }
      return `${ref}\n`;
    }
    if (args[0] === 'show') {
      const key = args[1];
      if (Object.prototype.hasOwnProperty.call(showThrow, key)) throw showThrow[key];
      if (Object.prototype.hasOwnProperty.call(blobs, key)) return blobs[key];
      // Path missing at resolved ref (measured git wording).
      const colon = key.indexOf(':');
      const ref = key.slice(0, colon);
      const p = key.slice(colon + 1);
      const err = new Error(`Command failed: git show ${key}`);
      err.stderr = `fatal: path '${p}' does not exist in '${ref}'\n`;
      err.status = 128;
      throw err;
    }
    if (args[0] === 'diff' && args[1] === '--name-only') {
      return changed.join('\n') + (changed.length ? '\n' : '');
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
}

function missingPathErr(ref, p) {
  const err = new Error('missing');
  err.stderr = `fatal: path '${p}' does not exist in '${ref}'\n`;
  err.status = 128;
  return err;
}

// ── unit: discrimination helper ──────────────────────────────────────────────

test('isPathAbsentAtRef matches measured git missing-path stderr', () => {
  assert.equal(
    isPathAbsentAtRef({ stderr: "fatal: path 'x.yaml' does not exist in 'abc123'\n" }),
    true,
  );
  assert.equal(
    isPathAbsentAtRef({ stderr: "fatal: path 'x.yaml' exists on disk, but not in 'abc123'\n" }),
    true,
  );
  assert.equal(
    isPathAbsentAtRef({ stderr: "fatal: invalid object name 'notareal'.\n" }),
    false,
  );
  assert.equal(
    isPathAbsentAtRef({ stderr: 'fatal: bad object abc\n' }),
    false,
  );
});

// ── blobAt ───────────────────────────────────────────────────────────────────

test('(a) missing path → absent (null); NEW_ARTIFACT path intact in derive', () => {
  const gitImpl = makeGitImpl({
    blobs: {
      // base: path absent (not in blobs → show throws path-does-not-exist)
      'head:api/openapi.yaml': 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n',
    },
    changed: ['api/openapi.yaml'],
  });

  assert.equal(blobAt('base', 'api/openapi.yaml', '/tmp', gitImpl), null);
  assert.equal(
    blobAt('head', 'api/openapi.yaml', '/tmp', gitImpl),
    'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n',
  );

  const { artifacts } = deriveArtifactsFromDiff({
    baseRef: 'base',
    headRef: 'head',
    cwd: '/tmp',
    gitImpl,
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].before, '', 'absent before maps to empty for NEW_ARTIFACT wire shape');
  assert.ok(artifacts[0].after.length > 0);
  assert.notEqual(artifacts[0].before, artifacts[0].after);
});

test('(b) bad-ref on before → ARTIFACT_UNREADABLE, not a new-artifact pass', () => {
  const gitImpl = makeGitImpl({
    badRefs: ['badbase'],
    blobs: {
      'head:api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
    },
    changed: ['api/openapi.yaml'],
  });

  assert.throws(
    () => blobAt('badbase', 'api/openapi.yaml', '/tmp', gitImpl),
    (err) => {
      assert.equal(err.code, 'ARTIFACT_UNREADABLE');
      assert.match(err.message, /artifact_unreadable/);
      assert.match(err.message, /bad_ref|invalid object/i);
      return true;
    },
  );

  assert.throws(
    () => deriveArtifactsFromDiff({
      baseRef: 'badbase',
      headRef: 'head',
      cwd: '/tmp',
      gitImpl,
    }),
    (err) => {
      assert.equal(err.code, 'ARTIFACT_UNREADABLE');
      assert.equal(err.side, 'before');
      assert.equal(err.path, 'api/openapi.yaml');
      // Must not return artifacts that look like NEW_ARTIFACT
      return true;
    },
  );
});

test('(c) after-side unreadable mirror', () => {
  const showErr = new Error('corrupt');
  showErr.stderr = 'error: object file .git/objects/xx is empty\n';
  showErr.status = 128;

  const gitImpl = makeGitImpl({
    blobs: {
      'base:api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
    },
    showThrow: {
      'head:api/openapi.yaml': showErr,
    },
    changed: ['api/openapi.yaml'],
  });

  assert.throws(
    () => blobAt('head', 'api/openapi.yaml', '/tmp', gitImpl),
    (err) => err.code === 'ARTIFACT_UNREADABLE',
  );

  assert.throws(
    () => deriveArtifactsFromDiff({
      baseRef: 'base',
      headRef: 'head',
      cwd: '/tmp',
      gitImpl,
    }),
    (err) => {
      assert.equal(err.code, 'ARTIFACT_UNREADABLE');
      assert.equal(err.side, 'after');
      return true;
    },
  );
});

test('(d) present-empty string stays present, not absent', () => {
  const gitImpl = makeGitImpl({
    blobs: {
      'base:api/openapi.yaml': '', // legitimate empty blob
      'head:api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
    },
    changed: ['api/openapi.yaml'],
  });

  assert.equal(blobAt('base', 'api/openapi.yaml', '/tmp', gitImpl), '');
  assert.notEqual(blobAt('base', 'api/openapi.yaml', '/tmp', gitImpl), null);

  const { artifacts } = deriveArtifactsFromDiff({
    baseRef: 'base',
    headRef: 'head',
    cwd: '/tmp',
    gitImpl,
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].before, '');
  // Empty present → content is a change vs head; not skipped as both-absent
  assert.ok(artifacts[0].after.length > 0);
});

test('(e) MUST-FAIL fixture: old flatten would treat bad-ref as absent NEW_ARTIFACT', () => {
  // Pre-fix: catch (_) { return '' } made bad-ref look like empty before + real after.
  // Under the fix this MUST throw ARTIFACT_UNREADABLE. A guard that cannot fail is broken.
  const gitImpl = makeGitImpl({
    badRefs: ['broken-base'],
    blobs: {
      'head:openapi.yaml': 'openapi: 3.0.0\ninfo: { title: t, version: "1" }\npaths: {}\n',
    },
    changed: ['openapi.yaml'],
  });

  let threw = null;
  try {
    deriveArtifactsFromDiff({
      baseRef: 'broken-base',
      headRef: 'head',
      cwd: '/tmp',
      gitImpl,
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'must throw (old behavior returned artifacts silently)');
  assert.equal(threw.code, 'ARTIFACT_UNREADABLE');
  assert.notEqual(threw.code, 'NEW_ARTIFACT');
  // Explicit: we did not get a successful derive with empty before
  assert.equal(threw.side, 'before');
});

test('isPathAbsentAtRef: missingPathErr helper used by inject is classified absent', () => {
  assert.equal(isPathAbsentAtRef(missingPathErr('abc', 'x.yaml')), true);
});
