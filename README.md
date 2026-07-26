# CodeRifts Contract Gate

A GitHub Action that **blocks a merge unless a valid signed ALLOW receipt exists for the PR's actual head diff** — the server-independent enforcement point that an in-process agent cannot bypass.

> Distinct from [`coderifts/action`](https://github.com/coderifts/action), which is the *advisory* breaking-change action (posts a PR comment). This gate is a **required-check** enforcement point with **offline cryptographic** receipt verification.

## What it does (fail-closed at every step)

1. **Derives the change set from the PR's real head diff** (`git diff base...head`) — the contract artifacts come from the actually-changed files, never from caller input. This closes the bypass where an agent submits an unchanged base spec to obtain a clean receipt while merging something breaking.
2. **Calls `POST /api/v1/preflight`** with those artifacts (the v4, envelope-bound receipt path — not `/api/diff`, whose v3 receipt is unbound).
3. **Verifies the receipt OFFLINE against a pinned keyring** (`keyring/pinned-keys.json`). It **never fetches the verification key from the server it is verifying**. The v4 `body_hash` binding proves the receipt is for *this exact* decision envelope.
4. **Binds to the head SHA** (recorded in the check output) so a later push can't ride an old receipt.
5. **Passes iff** the receipt verifies **and** `execution_action` is `CONTINUE` or `CONTINUE_WITH_MONITORING`. Fails on `BLOCK`, `REQUIRE_APPROVAL`, unverified/missing/tampered/expired/unknown-key. Semantics = *"signed ALLOW for this exact diff"*, not *"breaking == 0"*.
6. **Posts a Check Run** named **`CodeRifts / contract-gate`** (stable) — `success` only on pass. Mark it a required status check in branch protection to make merges unbypassable.

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
```

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

## Dependencies

Zero runtime dependencies — Node builtins only, plus a vendored, byte-identical copy of the frozen
receipt verifier (`src/verify.js`, from `receipt-verifier/verify.js`). Minimal supply-chain surface
for a security gate.
