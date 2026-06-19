# @tinysend/better-auth — spec

a real better-auth plugin (`satisfies BetterAuthPlugin`) that turns an app's auth
users into a consented tinysend audience. models the accepted better-auth-attio-plugin
pattern (schema + init/databaseHooks + endpoints + hooks), but targets an email list
instead of a CRM. status: built 2026-06-19, NOT resubmitted to better-auth (anton's call).

## how it compares to CRM plugins

- attio plugin: syncs users into a CRM so sales/ops act on them. operational.
- tinysend plugin: syncs users into an email list you broadcast to, owning consent + unsubscribe, and can actually send. marketing/comms. no email-audience plugin existed before; only the CRM one.

## package exports

- `@tinysend/better-auth` → `tinysend(opts)` server plugin + `senders` (email option adapters)
- `@tinysend/better-auth/client` → `tinysendClient()`
- peer deps: `better-auth >=1.0.0`, `tinysend >=0.5.0`. no `better-auth` import in senders (structurally compatible); the plugin does import it.

## options (TinysendOptions)

- apiKey, listId, appUrl (required; appUrl used to self-register the unsubscribe webhook)
- optIn: "double" (default) | "single"
- subscribeOnSignup: default true
- from?: sender (optional with a mailbox key)
- mapContact?(user) → { tags?, metadata?, org?, jobTitle? } — what to push onto the tinysend contact
- notifications?: { passwordChanged, emailChanged, twoFactor } | false (default all on)
- webhookPath (default "/tinysend/webhook"), registerWebhook (default true)
- waitUntil? (edge), onError?

## schema (added)

- user.tinysendSubscriberId (string) — the subscriber id, used to unsubscribe + match webhooks
- user.newsletterStatus (string) — "pending" | "subscribed" | "unsubscribed" | "none"
- tinysendWebhook table { listId unique, webhookId, secret } — stores the self-registered webhook + its HMAC secret

## opt-in (both via subscribers.create — carries tags/metadata either way)

- double (default): `subscribers.create({ verified:false })` → status "pending"; tinysend sends the confirmation email; `subscriber.confirmed` webhook flips the user to "subscribed". gdpr-safe.
- single: `subscribers.create({ verified:true })` → "subscribed" immediately. use only with explicit consent. better-auth email-verification is account security, NOT marketing consent — kept separate.

## endpoints (under /api/auth)

- POST /tinysend/subscribe (session) — subscribe/re-subscribe current user
- POST /tinysend/unsubscribe (session) — `subscribers.update(status:"unsubscribed")` + set user status
- GET  /tinysend/preferences (session) — { status, listId }
- POST /tinysend/webhook (no session) — verifies `X-Tinysend-Signature` (HMAC-SHA256 hex) against the stored secret; on `subscriber.confirmed|unsubscribed|deleted` updates the matching user by tinysendSubscriberId

## sync directions

- signup → tinysend: init/databaseHooks.user.create.after (subscribe per optIn)
- in-app toggle → tinysend: subscribe/unsubscribe endpoints
- email/STOP/one-click unsub → better-auth: webhook → user.newsletterStatus
- security notifications: hooks.after on password/email/2FA-change paths

## metadata + tags model (tinysend side — Phase 1, shipped to schema 2026-06-19)

decided after reading the code: tinysend already models this; we did NOT invent a tags taxonomy or custom_fields.

- attribution: subscriber `source` = "api"/"better-auth" + `source_details` (existing).
- arbitrary per-person values: `contacts.metadata` (jsonb) — added to mirror the existing `subscribers.metadata`. NOT "custom_fields" (same thing, bad name).
- labels: `contacts.tags` (text[] + GIN index) — person-level, global across lists.
- identity: existing contact fields (org, jobTitle, phone, ...).
- segmentation = filter on tags/metadata/contact fields (the MCP segment-send flow), not a separate segment object.

writes are additive (tags unioned, metadata shallow-merged, never cleared) via `applyContactAttributes` in the data layer; exposed through `subscribers.create` API params `tags/metadata/org/job_title` and the SDK `CreateSubscriberParams`.

## tags in Apple Contacts (CardDAV)

tags render as vCard CATEGORIES on the contact card (Apple shows them). decided default: CATEGORIES (quiet, portable); a browsable `tag-{slug}` group is a future opt-in. lists stay as their own `group-{listId}` groups — tags and lists are separate axes, never conflated.

## Phase 1 status (tinysend product) — DONE in code, not yet deployed

- migration applied to prod: contacts.tags + contacts.metadata + GIN index
- data layer: addSubscriber accepts `contact: {tags, metadata, org, jobTitle}`, merges additively
- API: POST .../subscribers accepts tags/metadata/org/job_title
- SDK: CreateSubscriberParams gains the same (typecheck + openapi pass)
- CardDAV: contacts.tags → CATEGORIES on the contact vCard
- pending deploy: api + carddav workers; publish SDK 0.5.0; then publish @tinysend/better-auth 0.2.0
