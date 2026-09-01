# CodeRifts Contract Gate

A GitHub Action that **fails its check unless a valid signed ALLOW receipt exists for the PR's actual head diff**, verified offline against a pinned keyring. Marked **required** in branch protection, that failing check blocks the merge ([ENFORCEMENT.md](ENFORCEMENT.md)); on its own it posts a Check Run and nothing more. It runs in CI rather than in the agent's process, so it does not depend on the agent's cooperation — but a repository admin with `enforce_admins: false` can still merge past it ([SECURITY.md](SECURITY.md)).

> Distinct from [`coderifts/action`](https://github.com/coderifts/action), which is the *advisory* breaking-change action (posts a PR comment). This gate is a **required-check** enforcement point with **offline cryptographic** receipt verification.

## What it does (fail-closed at every step)

1. **Derives the change set from the PR's real head diff** (`git diff base...head`) — the contract artifacts come from the actually-changed files, never from caller input. This closes the bypass where an agent submits an unchanged base spec to obtain a clean receipt while merging something breaking.
2. **Calls `POST /api/v1/preflight`** with those artifacts (the v4, envelope-bound receipt path — not `/api/diff`, whose v3 receipt is unbound).
3. **Verifies the receipt OFFLINE against a pinned keyring** (`keyring/pinned-keys.json`). It **never fetches the verification key from the server it is verifying**. The v4 `body_hash` binding proves the receipt is for *this exact* decision envelope.
4. **Binds to the head SHA** (recorded in the check output) so a later push can't ride an old receipt.
5. **Passes iff** the receipt verifies **and** `execution_action` is `CONTINUE` or `CONTINUE_WITH_MONITORING`. Fails on `BLOCK`, `REQUIRE_APPROVAL`, unverified/missing/tampered/expired/unknown-key. Semantics = *"signed ALLOW for this exact diff"*, not *"breaking == 0"*.
6. **Posts a Check Run** named **`CodeRifts / contract-gate`** (stable) — `success` only on pass. Mark it a required status check in branch protection to make merges unbypassable.

> **CWM honesty.** With `require_verified_monitoring: true` the gate verifies a `cr.monitor.attest.v1` token offline against a pinned monitoring keyring (CWM passes only on `delivered_acked`); by default it passes CWM on the host's claim. The token proves a monitoring-key holder observed the delivery — not that a human read it, not that the sink targets the right audience. Unsigned JSON is not accepted under the flag.

## Making it block merges (not just advise)

Posting the check is advisory until you mark it **required**. See **[ENFORCEMENT.md](ENFORCEMENT.md)**
for the exact steps (copy [`examples/contract-gate.yml`](examples/contract-gate.yml), then run
[`scripts/require-contract-gate.sh`](scripts/require-contract-gate.sh) or the UI), the stable
check-name contract, and how to close the fail-open gaps. See **[SECURITY.md](SECURITY.md)** for the
trust model and the admin-override residual.

## Usage

```yaml
on: pull_request
jobs:
  contract-gate:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # required: base..head must be available locally
      - uses: coderifts/contract-gate@v0
        with:
          api-key: ${{ secrets.CODERIFTS_API_KEY }}
          # Optional: require a signed monitoring-delivery attestation on CWM
          # require-verified-monitoring: 'true'
          # monitoring-attestation: ${{ vars.CODERIFTS_MONITORING_ATTESTATION }}
          # monitoring-keyring: ${{ github.workspace }}/.coderifts/monitoring-keys.json
```

## Two integrations, one name

The CodeRifts GitHub App posts a check named `CodeRifts / contract-gate`, and by default so does
this Action. A repository running both shows two checks under the same name, and a branch-protection
rule requiring that context cannot distinguish them. Set `check-name` on the Action when both run:

```yaml
      - uses: coderifts/contract-gate@v0
        with:
          api-key: ${{ secrets.CODERIFTS_API_KEY }}
          check-name: 'contract-gate (Action)'
```

Whichever name is posted is the one to require in branch protection — see
[ENFORCEMENT.md](ENFORCEMENT.md). Leave the default when only the Action runs; changing it for no
reason means the documented required-check context no longer matches what is posted.

## Trust model — pinned keyring

The gate ships a **pinned public keyring** and verifies **offline** against it. It never trusts the
server under test to supply its own verification key.

- **Trust-on-first-pin.** `keyring/pinned-keys.json` was pinned from
  `GET /api/v1/attestation/public-key` at build time.
- **Currently pinned:** `kid = 2026-07-k1` (Ed25519).
- **Rotation is additive.** To rotate, open a PR that **adds** the new key entry to the keyring
  (both old and new keys remain valid for in-flight receipts). Never replace — replacing would
  reject receipts signed by the still-valid old key.
- The gate loads **only** this file. If a receipt's `kid` is not in the pinned keyring, verification
  fails closed (`UNKNOWN_KEY`). The network key-fetch fallback is not used on the gate path.

## Contract file classification

Changed files are classified into preflight artifact types: `openapi`/`swagger` (`*.yaml|json`,
`*-api.*`, `api/*`), `graphql` (`*.graphql|gql`), `grpc` (`*.proto`), `asyncapi`, `mcp_manifest`.
A diff that changes no contract file passes with `no_contract_changes` (nothing to govern).

## Releasing

This Action is consumed by tag, not from a registry: a release is a `package.json` bump in its own
commit, a `vX.Y.Z` tag, and moving the floating `v0` tag. Nothing in that path reads `CHANGELOG.md`,
which is how `v0.5.0`, `v0.6.0` and `v0.7.0` were each tagged with no section — two of them without
GitHub release notes either, leaving `git log` as the only record.

Before tagging:

```bash
npm run release:check   # fails if CHANGELOG.md has no "## <package.json version>" heading
```

CI runs the same check on every push and pull request, so a bump commit that omits the section fails
when it lands rather than at tag time.

## Dependencies

Zero runtime dependencies — Node builtins only, plus a vendored, byte-identical copy of the frozen
receipt verifier (`src/verify.js` and `src/arity.js`, from `receipt-verifier`). Minimal supply-chain
surface for a security gate. The copied revision and the SHA-256 of each file are recorded in
[`VENDOR.md`](VENDOR.md) and `src/VENDOR.sha256`; `test/vendor-core.test.js` fails if either file
drifts from its pin, and separately re-checks the key-status behaviour the pin exists to protect.
