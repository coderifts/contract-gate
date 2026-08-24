# Trust model

The contract gate is designed so that **merging a breaking contract change requires a cryptographic
proof that a CodeRifts decision approved the exact diff being merged** — a proof the CI runner
verifies itself, and that branch protection makes non-optional.

## What provides which guarantee

| Property | Provided by |
|---|---|
| The decision covers the **real** merge candidate, not a substituted clean spec | Artifacts derived from `git diff base...head` in the runner — never caller input (Gap-5) |
| The approval is **authentic** (issued by CodeRifts, not forged) | Ed25519 signature verified **offline** against the **pinned keyring** (`keyring/pinned-keys.json`), never a key fetched from the server under test |
| The approval is **for this exact change set** | v4 receipt `body_hash` binding — the receipt is bound to the specific decision envelope built from the diff |
| The approval is an **ALLOW**, not just "few breaking changes" | Pass requires `execution_action ∈ {CONTINUE, CONTINUE_WITH_MONITORING}`. With `require_verified_monitoring: true` the gate verifies a `cr.monitor.attest.v1` token offline against a pinned monitoring keyring (CWM passes only on `delivered_acked`); by default it passes CWM on the host's claim. The token proves a monitoring-key holder observed the delivery — not that a human read it, not that the sink targets the right audience. |
| The proof is **unbypassable at merge** | GitHub branch protection: `CodeRifts / contract-gate` as a **required** status check |

The first four are enforced by the action itself (fail-closed). **The last one is what makes it
matter** — without a required status check, the gate only advises.

## Pinned keyring

The gate verifies **offline** against a bundled keyring and **never** asks the server it is
verifying for the verification key (that would re-trust the thing under test). Currently pinned:
`kid = 2026-07-k1` (Ed25519). Rotation is **additive** — add the new key entry in a PR; both old and
new keys stay valid so in-flight receipts still verify. An unpinned `kid` fails closed (`UNKNOWN_KEY`).

## Residual: administrator override

Branch protection is a GitHub feature, and GitHub lets repository **administrators bypass** required
checks unless you explicitly forbid it. For **true** enforcement:

- **UI:** enable **Include administrators** (or "Do not allow bypassing the above settings") on the
  protection rule.
- **API:** set `"enforce_admins": true` (the provided `scripts/require-contract-gate.sh` does this).

With `enforce_admins: true`, even an admin cannot merge a PR whose `CodeRifts / contract-gate` check
is failing or missing. Without it, an admin can override — document who holds admin, because that is
your remaining trust boundary. Other standard GitHub escape hatches (disabling the rule, deleting the
workflow) are also admin-only actions and should be governed the same way.

## What this gate does NOT claim

- It does not stop a change from being **written** — it stops it from being **merged** to a
  protected branch. (The in-process `@coderifts/agent-guard` is the write-time layer; this is the
  server-independent merge-time layer.)
- It governs the contract artifact families it classifies (openapi/graphql/grpc/asyncapi/
  mcp-manifest). A contract expressed in an unclassified file would not be detected — extend
  `src/artifacts.js` classifiers as needed.
