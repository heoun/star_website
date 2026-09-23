# Temporary property collaboration

An Admin opens a property and grants an active Agent temporary access (7 days by default, 1–90 days in the UI). This does not change the Agent's role or marketing property assignments.

The Agent's server-rendered navigation includes Properties & Settings only while an open assignment is unexpired. The collaboration list and detail endpoints check active staff membership, assigned email, state and expiry on every request. Drafts and supporting files remain private; expired or ended assignments are readable only by Admin.

Agent and Admin use the same 15-step property editor, including field controls, missing-value indicators, address and signer dialogs. Each editor instance owns its own cache and transport; the Agent transport only saves versioned collaboration drafts and cannot forward live settings writes. Submitted drafts use the same editor in read-only mode.

Agents save proposed property details and manager-source lease fields in a separate record. The collaboration pages do not show supporting documents or provide an upload entry point. Previously stored files and their protected API remain retained.

Submission locks Agent editing. Admin reviews a before/proposed comparison, then approves, returns for correction, or ends access. Approval writes building fields, lease settings and audit history in one database transaction, then ends the assignment. An Admin cannot approve a draft they authored as an Agent. Admin can review previously submitted work after the Agent's access expires.

Each draft has optimistic version checks. Approval also locks and compares the live building/settings with the grant-time snapshot; changed live values cause a conflict. End the old assignment and create a fresh one in that case; the prior proposal remains available in Admin history. No automatic merge or overwrite is attempted.

The database RPC is executable only by the existing service role; Worker authentication supplies the actor. The database independently checks current staff role and active status. Granting, reviewing and ending access require recent MFA when account security is enabled. Platform Owner and Landlord do not receive business collaboration access.

Validation:
- `node scripts/test-property-collaboration.mjs`: database state transitions, access boundaries, stale drafts, conflicts, public database restrictions and field validation.
- `npm run test:property:collaboration:ui`: isolated browser grant → draft → submit → approve workflow, access closure and mobile layout.
- `npm run test:identity:ui`: existing authentication and server-side workspace shell regression checks.

Apply `supabase/property-collaboration.sql` after the existing schema. It is included in the release schema bundle. Dev and production require separate migrations and releases.

When recent MFA is required, grant and review actions open an in-page verification dialog and preserve the form. GIP verifies the current workspace password followed by an enrolled TOTP factor. The encrypted five-minute challenge is bound to the current subject and email; failed or cancelled verification does not clear the session. A successful check retries the requested operation once, with server permissions and version checks still applied.

Property settings in both roles include a read-only template preview below the current step. One occurrence is shown at a time, with previous/next and a location directory. The preview patches unsaved input locally without saving or calling signing services. Tenant/listing fields remain source-labelled placeholders. Locations use template section numbers rather than claiming final PDF page numbers. The existing rental document workspace keeps its own preview.
