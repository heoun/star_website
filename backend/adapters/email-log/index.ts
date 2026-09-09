// Records every send in memory and prints it, links included, so a dev flow
// is clickable from the console. listSent() is fake-only surface: the
// composition root exposes it on a dev route; nothing else may touch it.

import type { EmailPort, EmailSend } from "../../contracts/email.ts";

export interface SentMail extends EmailSend {
  messageId: string;
  at: string;
}

const sent: SentMail[] = [];

export function makeLogEmail(): EmailPort {
  return {
    async send(msg) {
      const record: SentMail = { ...msg, messageId: `mail-${sent.length + 1}`, at: new Date().toISOString() };
      sent.push(record);
      console.log(`[email-log] ${record.template} -> ${record.to.join(", ")} ${JSON.stringify(record.data)}`);
      return { messageId: record.messageId };
    },
  };
}

export function listSent(): SentMail[] {
  return sent;
}
