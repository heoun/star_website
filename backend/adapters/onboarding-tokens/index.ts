import type { OnboardingTokens } from "../../contracts/administration.ts";
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
export function makeOnboardingTokens(): OnboardingTokens {
  const hash = async (token: string) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
  return { hash, async issue() { const token = hex(crypto.getRandomValues(new Uint8Array(32))); return { token, hash: await hash(token) }; } };
}
