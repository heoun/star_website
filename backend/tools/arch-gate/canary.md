# The Canary

Ring 0 must prove the fence rejects, not just that it exists. The check: a scratch
branch adds `import { x } from "../../adapters/db-memory/whatever"` inside `backend/core/`,
CI runs, and the arch-gate job fails on rule `core-imports-contracts-only`. Delete the
branch; record the failing run's link here. Repeat whenever the gate config changes.
