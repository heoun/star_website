// Read-only metadata check. No application records or credentials are printed.
import { readFile } from "node:fs/promises";
const vars = { ...process.env };
try {
  for (const line of (await readFile(new URL("../.dev.vars", import.meta.url), "utf8")).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !vars[match[1]]) vars[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {}
if (!vars.SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("Workspace schema check: Supabase configuration is missing.");
  process.exitCode = 1;
} else {
  try {
    const url = new URL("/rest/v1/applications", vars.SUPABASE_URL);
    url.searchParams.set("select", "responsible_email,collaborator_emails,workspace_version,workspace");
    url.searchParams.set("limit", "0");
    const response = await fetch(url, { headers: { apikey: vars.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${vars.SUPABASE_SERVICE_ROLE_KEY}` }, signal: AbortSignal.timeout(12000) });
    const result = await response.json().catch(() => ({}));
    console.log(JSON.stringify({ workspaceColumnsAvailable: response.ok, status: response.status, ...(response.ok ? {} : { code: result.code || "unknown" }) }));
    if (!response.ok) process.exitCode = 1;
  } catch {
    console.log("Workspace schema check: database could not be reached.");
    process.exitCode = 1;
  }
}
