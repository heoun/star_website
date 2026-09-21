# Sender avatar for Star email

The inbox avatar beside `Star Realty <no-reply@starreusa.com>` is controlled by
the recipient's email service. The HTML logo, Resend dashboard domain logo and
mail headers do not configure that avatar. All website email templates continue
to use the shared sender and body branding; Supabase Auth must use the same
sender through its SMTP settings.

## First option: Google account profile picture

The current chosen approach is to try the free Google account picture before
buying a mark certificate. Google's Gmail Help documents that an account photo
can appear beside the sender's name and in notifications to other Gmail users.
This is separate from BIMI and does not require a CMC/VMC.

First determine whether `no-reply@starreusa.com` is an actual Google account, an
alias, or only a Resend sending address. Set the Star logo on the matching
account's Google profile and inspect its visibility settings. An admin directory
photo and an independently editable alias photo must not be assumed equivalent.
Then verify received Resend/Supabase messages in another Gmail account: Google's
profile documentation does not promise that every third-party SMTP message or
mail client will display that photo. Do not replace this test with a recipient's
local contact photo, which would only change that recipient's view.

The Cloudflare and Google Workspace Admin dashboards are now logged in, but DNS
remains unchanged while this option is evaluated. The user declined the proposed
certificate price and has not confirmed 12 months of logo use; there is no
authorization to purchase a certificate or start a subscription.

The Google Admin directory contains seven users and no `no-reply@starreusa.com`
user. The `info@starreusa.com` user has no alternate email aliases. Its Google
account already has a blue Star logo and profile-picture visibility is
**Anyone**. No profile or directory settings were changed. Reusing this profile
would require an intentional sender-address change to `info@starreusa.com`,
including Resend website mail and Supabase SMTP sender configuration, followed
by recipient-side verification. Keeping the current no-reply sender requires
separately resolving its Google identity; do not create a paid Workspace seat
merely to obtain an avatar.

The user chose to retain `no-reply@starreusa.com`. After explicit confirmation
of Google's agreement at checkout, **Cloud Identity Free** was activated for
the organization ($0, no payment required). A dedicated `Automated Mail`
organizational unit was created. Its Google Workspace Business Starter
automatic licensing is explicitly **OFF**, while Google Voice Starter inherits
**OFF**. The root organizational unit's employee licensing was not changed.

The new-user form is prepared for `Star Realty`, `no-reply@starreusa.com`, in
`Automated Mail`, with `site/png/email-logo-v1.png` attached. Creation and the
initial credential flow are handed to the user. After creation, verify that
the account has only Cloud Identity Free (no paid Workspace seat), sign in as
that user, set profile-photo visibility to Anyone, and verify actual recipient
display. Cloud Identity supplies an identity, not a Gmail inbox. Its effect on
Resend sender avatars remains unverified until that last check.

## Current public configuration

Read-only DNS check on 2026-09-21:

- `_dmarc.starreusa.com`: `v=DMARC1; p=none; rua=mailto:info@starreusa.com`
- `default._bimi.starreusa.com`: no TXT record returned.
- MX: `1 smtp.google.com.`
- Authoritative DNS: Cloudflare (`bjorn.ns.cloudflare.com`, `emely.ns.cloudflare.com`).

Received-message authentication headers were also inspected, without sending
new mail. A Resend website notification passed SPF, aligned DKIM
(`d=starreusa.com; s=resend`) and DMARC. A Google Workspace message passed
aligned SPF and DMARC, but its DKIM signature used Google's
`starreusa-com.20251104.gappssmtp.com` domain. Check/enable custom-domain DKIM in
Google Admin before relying on forwarded Workspace messages to retain alignment.
These samples do not establish alignment for every sender or forwarding route.

No DNS or provider settings were changed. Gmail BIMI needs a CMC or VMC plus
DMARC enforcement (`p=quarantine` or `p=reject`, `pct=100`). A certificate has
not yet been supplied. Consequently, sender-avatar activation is still pending.

The existing Wrangler OAuth login can read zones but has no DNS-edit scope.
The Cloudflare dashboard login is available if later needed; no new API
credentials have been requested or created.

## Prepared asset

`site/brand/star-bimi.svg` reuses the paths from `site/partials/brand-logo.html`,
with explicit black fill, a solid white square background, title/description,
512-pixel dimensions and SVG Tiny P/S metadata. It contains no external assets,
scripts or embedded bitmap. Have the certificate issuer validate this candidate
and certify these exact logo bytes. This asset is not itself a certificate.

After deployment, its intended URL is `https://starreusa.com/brand/star-bimi.svg`.
Do not publish a BIMI DNS assertion until its public asset/certificate URLs work.

## Completion steps

1. Obtain or locate the organization's CMC/VMC for this logo and domain. The CA
   validates brand eligibility; a VMC also qualifies for Gmail's verified check.
2. Check DMARC alignment for each legitimate sender: Google Workspace, Resend
   website notifications, and Supabase Auth through Resend SMTP. Review DMARC
   reports before enforcing the policy for the entire domain.
3. Publish the CA's public PEM certificate chain on HTTPS, with no login. Never
   publish a private key. Use the issuer's final approved SVG if it differs from
   the prepared candidate.
4. Once sender alignment is confirmed, the proposed DMARC record is
   `v=DMARC1; p=quarantine; pct=100; rua=mailto:info@starreusa.com`.
5. Add `default._bimi.starreusa.com` TXT using the actual certificate URL. Google
   documents the PEM-embedded-logo form `v=BIMI1; l=; a=https://<host>/<certificate>.pem`.
   Follow the CA's record instructions if it also supplies a separate SVG URL.
6. Validate public DNS, HTTPS assets, certificate chain, domain match and expiry.
   After DNS propagation, inspect newly received Gmail messages and their
   authentication results. Test both a website notification and Supabase Auth.

Purchasing a certificate, deploying assets and applying production DNS changes
are separate rollout steps. A logo cannot be forced onto every email client;
mailbox support, authentication and recipient-provider policy determine display.

## Certificate application preparation

- Domain: `starreusa.com`; website sender: `no-reply@starreusa.com`.
- Logo candidate: `site/brand/star-bimi.svg`, pending issuer validation.
- CMC is the candidate if this logo has at least 12 months of public use and no
  qualifying registered trademark. VMC is an option with a qualifying trademark.
- Still needed from the business: legal entity information, logo eligibility
  evidence, authorized applicant and issuer account. Do not infer legal identity
  from the website's display name.
- DigiCert's public page on 2026-09-21 lists a CMC 12-month automatically renewing
  subscription at $1,416 and VMC at $1,752; its displayed monthly figures are
  inconsistent with those totals, so the actual checkout quote governs. No
  purchase or subscription has been started.
- The issuer performs organization and applicant identity verification. Prepare
  the application with the business, then hand off identity checks, acceptance
  of legal terms and any payment requiring the user's participation.

## Official references

- [Google: Change your Gmail profile picture](https://support.google.com/mail/answer/35529?hl=en)
- [Google: Set up BIMI](https://knowledge.workspace.google.com/admin/security/set-up-bimi)
- [Resend: BIMI changes, CMC and Apple Branded Mail](https://resend.com/blog/email-changes-for-bimi)
- [DigiCert: Mark certificate products and pricing](https://www.digicert.com/buy-a-mark-certificate)
- [DigiCert: Request a mark certificate](https://docs.digicert.com/en/certcentral/order-and-manage-certificates/request-certificates/request-mark-certificate.html)

Google documents the certificate, DMARC and SVG requirements and notes that
appearance can take up to 48 hours after adding the DNS record. Apple Branded
Mail is a separate provider-specific option; it does not activate Gmail avatars.
