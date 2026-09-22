// Domain events, printed and kept. A later ring swaps this for an outbox
// without touching a single emitter.

import type { DomainEvent, EventSink } from "../../contracts/events.ts";

const seen: { at: string; event: DomainEvent }[] = [];

export function makeLogEvents(): EventSink {
  return {
    async emit(event) {
      seen.push({ at: new Date().toISOString(), event });
      console.log(`[event] ${event.type}`, JSON.stringify(event));
    },
  };
}

export function listEvents() {
  return seen;
}
