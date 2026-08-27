'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { encodeMarker, parseMarker, selectGrantForHead } = require('../src/grant-delivery');

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('1094 PR-comment grant delivery', () => {
  it('round-trips a marker', () => {
    const text = encodeMarker({ head_sha: HEAD, after_payload_hash: 'sha256:ab', grant: 'tok.sig' });
    const p = parseMarker(text);
    assert.equal(p.ok, true);
    assert.equal(p.head_sha, HEAD);
    assert.equal(p.grant, 'tok.sig');
  });

  it('BITE: grant for another head_sha → grant_bound_elsewhere (BLOCK)', () => {
    const comments = [{ body: encodeMarker({ head_sha: OTHER, after_payload_hash: 'sha256:ab', grant: 'tok.sig' }) }];
    const r = selectGrantForHead(comments, HEAD);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'grant_bound_elsewhere');
  });

  it('matching head_sha is selected', () => {
    const comments = [
      { body: encodeMarker({ head_sha: OTHER, after_payload_hash: 'sha256:x', grant: 'old' }) },
      { body: encodeMarker({ head_sha: HEAD, after_payload_hash: 'sha256:ab', grant: 'tok.sig' }) },
    ];
    const r = selectGrantForHead(comments, HEAD);
    assert.equal(r.ok, true);
    assert.equal(r.grant, 'tok.sig');
  });
});
