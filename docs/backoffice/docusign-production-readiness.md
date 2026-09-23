# DocuSign production readiness

## Scope

Prepare production signing independently of the Dev release. Dev continues to use DocuSign Demo. Promoting an integration key does not migrate test envelopes, signatures, documents, or business data, and does not deploy this application.

## Verified on 2026-09-22

- The company production DocuSign account is accessible to its administrator.
- A separate NDA integration is already live. Do not modify or reuse its credentials for rental leases.
- The Dev configuration matches the `Star Realty Lease` integration in Apps and Keys.
- The lease integration was initially `Development / Ready to Submit`, with `Private custom integration` selected. After the user's browser handoff it now shows `Pending approval` and a required `Submit verification form` link. Approval has not been granted.
- The verification form requires an administrator's name matching their identification, an email with admin privileges in the production account, and the production Account ID. The signed form has not been submitted by this agent; the page advises allowing 48 hours for review after submission.
- The production account's Connect administration page is accessible and shows no account configurations. No lease webhook or HMAC setup has been verified yet. Envelope-level notification support still needs validation.
- Application code supports production OAuth and discovers the account API base URI through userinfo. Local signing cannot use production; staging deployment validation requires Demo.

The existing paid eSignature subscription alone is not evidence that this integration can use the production API. Use the Go-Live eligibility result and applicable account entitlements to establish that.

## Remaining setup

1. Complete Go-Live for the lease integration into the intended company account; verify `App is live` and the matching integration key in production Apps and Keys. Confirm any new charges or contractual commitments before proceeding.
2. Configure a separate production RSA keypair and authorize the intended production sender for the application's JWT flow (`signature impersonation`). Sandbox consent and credentials do not replace production authorization.
3. Configure production Connect HMAC verification. Use `https://starreusa.com/api/webhooks/docusign` for lease envelope notifications. Preserve unrelated account integrations and webhook subscriptions.
4. Store the production-only credentials in the production Worker: `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_PRIVATE_KEY`, `DOCUSIGN_CONNECT_HMAC_SECRET`. Set `DOCUSIGN_ENVIRONMENT=production` and the production webhook URL. Never copy Demo private keys or HMAC secrets into production.
5. Validate authentication and the selected account with read-only calls, without creating or sending an envelope. Keep sending disabled until the production application, schema, private document storage, callback inbox, scheduled processing, and archive retrieval have been released and verified together.
6. At the approved production release, enable the required rental/signing settings and validate notification processing. An end-to-end production signing check requires a separately authorized envelope and recipients; it must not use a real applicant's lease as an unapproved test.

## First real lease

Confirm the production case, lease terms, landlord decision, signer names and emails, and the complete document package before the staff send action. The Angelica Budram / Evergarden 4D case also needs a supported staff-confirmed path for its completed external screening; merely displaying the imported score does not satisfy the normal workflow's readiness gates. Do not send again for internal screening just to unblock signing.

Only a new production envelope can represent the real signing process. Retain the completed production PDF, completion certificate, envelope ID and audit events. Demo completion is not production completion.

## Official references

- [Go-Live guide and integration classifications](https://developers.docusign.com/platform/go-live/)
- [Updated Go-Live process: account eligibility replaces the former 20-call requirement](https://community.docusign.com/go-live-70/no-more-20-api-calls-introducing-the-streamlined-integration-go-live-experience-in-apps-keys-25623)

Update this record as each setup step is actually verified. This document is a readiness checklist, not a declaration that production signing is ready.
