# Backend

The leasing back office, rebuilt one ring at a time while the existing worker keeps serving the
site. New code lives here; `worker/index.js` mounts it route by route. Nothing in `worker/`,
`site/` or `lease/` is rewritten wholesale — routes move over when their ring lands.

The current three-role workspace is mounted at `/api/admin/cases` through
`app/workspace.ts`, with contracts, core rules and a Supabase repository adapter.
It uses the existing applications table. Account governance and landlord intake are composed through
`app/administration.ts`, with separate database, email and token adapters. The public intake
endpoint is `/api/landlord-onboarding`; the staff endpoints remain under `/api/admin`.
See [Backoffice implementation](../docs/backoffice/implementation.md)
for the additive SQL migration, permissions, external-receipt mode and tests.
The separate `/api/v2` fake-vendor flow is local-only; its smoke test does not
prove that production payment, screening or signing integrations are connected.

## The Three Rules

**1. Contracts before implementations.** Every module boundary is a file in `contracts/`.
A contract must pass review before any implementation of it is written. Changing a contract
is a reviewed change; implementations follow contracts, never the other way around.

**2. Implementations never import each other.** Everything imports `contracts/` and nothing
else. The one lawful exception is `app/` — the composition root — which is the only place
allowed to import from `adapters/` in order to wire the system together. The architecture
gate (`tools/arch-gate/`) enforces this in CI: a violating import fails the build.

**3. A new implementation touches no existing code.** Adding an adapter means exactly:
a new directory under `adapters/`, one registration line in `app/wiring.ts`, and additive
migration files if it needs tables. If it needs more than that, the contract is wrong —
go back and fix the contract through review. Never open a back door.

## Runnable Is the Only Pass

- `npm run dev` boots with **zero secrets**: every vendor adapter defaults to its fake.
- `npm run smoke` walks the whole flow over HTTP — listing → application → screening →
  staff review → landlord decision → lease generation → signatures → executed — and fails
  loudly at the first broken step.
- CI runs the architecture gate, the type check, and the smoke test. Three greens = runnable.
- Any change that breaks a green gets fixed before the next ring starts.

## Layout

    backend/
      contracts/     the only shared language; imports nothing but other contracts
      core/          use cases; imports contracts only
      adapters/      one directory per implementation; imports contracts + its own vendor SDK
        db-memory/         db-supabase/
        email-log/         email-resend/
        screening-fake/    screening-rentspree/   (or experian; port is vendor-neutral)
        esign-fake/        esign-docusign/
        storage-memory/    storage-r2/
        auth-fake/         auth-real/
        events-log/
      app/           composition root: wiring.ts, http routes, the mount for worker/index.js
      migrations/    numbered, additive; run by CI against dev, by hand against prod
      tools/
        arch-gate/   dependency-cruiser config + the canary that proves the fence works

## What the Gate Enforces

| From | May import |
|---|---|
| `contracts/` | `contracts/` only |
| `core/` | `contracts/`, `core/` |
| `adapters/<x>/` | `contracts/`, its own subtree, its own vendor package |
| `app/` | anything in `backend/` |
| `worker/`, `site/` | `backend/app/` only (the mount), never internals |

Dynamic `import()`/`require()` with non-literal paths is flagged too.

## Language

TypeScript for everything under `backend/`. Wrangler compiles it natively — no extra build
toolchain. The type check (`tsc --noEmit`) is part of CI; types are the cheapest half of
contract enforcement, the gate is the other half.

## How Review Works

Contracts are reviewed by Ocean. Until a contract file is approved, no implementation of it
is written. Approval of the initial set opens Ring 0 (see RINGS.md). After that, contract
changes ship as their own reviewed edits, separate from implementation changes.
