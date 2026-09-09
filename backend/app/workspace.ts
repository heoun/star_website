// Public mount for the existing Worker. Database and storage remain behind the
// repository port; policy and state changes have no HTTP/vendor dependencies.
export { makeWorkspace, canAccessCase, projectCase, projectLandlordProperty, allowedCaseActions, WorkspaceError } from "../core/workspace.ts";
import { makeWorkspace } from "../core/workspace.ts";
import { makeWorkspaceRepository } from "../adapters/workspace-supabase/index.ts";
export const workspaceFor = (config: { url: string; key: string }) => makeWorkspace(makeWorkspaceRepository(config));
