// Everything a use case may touch, assembled by app/wiring.ts.
// Core never sees an adapter — only these contract shapes.

import type { Repos } from "../contracts/repos.ts";
import type { ScreeningPort } from "../contracts/screening.ts";
import type { EsignPort } from "../contracts/esign.ts";
import type { EmailPort } from "../contracts/email.ts";
import type { StoragePort } from "../contracts/storage.ts";
import type { LeaseGenPort } from "../contracts/leasegen.ts";
import type { AuthPort } from "../contracts/auth.ts";
import type { EventSink } from "../contracts/events.ts";
import type { PolicyPort } from "../contracts/policy.ts";

export interface Deps {
  repos: Repos;
  screening: ScreeningPort;
  esign: EsignPort;
  email: EmailPort;
  storage: StoragePort;
  leasegen: LeaseGenPort;
  auth: AuthPort;
  events: EventSink;
  policy: PolicyPort;
}
