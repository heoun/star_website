// The mount worker/index.js calls. Everything under /api/v2 lands here.

import { authKind, buildDeps, dbKind, emailKind, storageKind } from "./wiring.ts";
import { route } from "./routes.ts";

interface WorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BACKEND_V2?: string;
  [key: string]: unknown;
}

export async function handleBackendRequest(request: Request, env: WorkerEnv): Promise<Response> {
  // The v2 flow still wires fake screening/signing and a separate Case store.
  // Keep that prototype local until its data has been migrated to this workspace.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) {
    return new Response(JSON.stringify({ error: "This experimental workflow is available locally only." }), {
      status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
  const deps = buildDeps(env, request);
  const response = await route(deps, request, { db: dbKind(env), auth: authKind(env), email: emailKind(env), storage: storageKind(env) });
  return deps.auth.decorateResponse?.(response) || response;
}
