# @tinysend/better-auth

Send better-auth's emails — verification, password reset, magic links, OTPs,
and account-security notifications — through [tinysend](https://tinysend.com).

Replies land in a real tinysend mailbox with webhooks and automations, so
"reset your password" emails are deliverable and answerable, not a dead no-reply.

## Install

```bash
npm install better-auth tinysend @tinysend/better-auth
```

## Usage

Create one tinysend client and wire the senders into better-auth's callbacks.

```ts
import { betterAuth } from 'better-auth';
import { magicLink, emailOTP } from 'better-auth/plugins';
import { Tinysend } from 'tinysend';
import { senders, tinysendPlugin } from '@tinysend/better-auth';

const ts = new Tinysend(process.env.TINYSEND_API_KEY!);

export const auth = betterAuth({
  emailVerification: {
    sendVerificationEmail: senders.verification(ts),
  },
  emailAndPassword: {
    enabled: true,
    sendResetPassword: senders.reset(ts),
  },
  plugins: [
    magicLink({ sendMagicLink: senders.magicLink(ts) }),
    emailOTP({ sendVerificationOTP: senders.otp(ts) }),
    // security notifications for events better-auth has no callback for
    // (password changed, email changed, 2FA toggled):
    tinysendPlugin({ client: ts }),
  ],
});
```

With a mailbox key (`sk_mbx_…`) the sending address is the mailbox, so `from`
is optional. With a project-wide key, pass `from`:

```ts
senders.verification(ts, { from: 'auth@yourdomain.com' });
```

## Senders

Every sender returns the exact callback shape better-auth expects, and throws on
failure so better-auth surfaces "could not send email".

- `senders.verification(ts, tpl?)` — `emailVerification.sendVerificationEmail`
- `senders.reset(ts, tpl?)` — `emailAndPassword.sendResetPassword`
- `senders.magicLink(ts, tpl?)` — `magicLink` plugin
- `senders.otp(ts, tpl?)` — `emailOTP` plugin (sign-in / verify / reset)
- `senders.twoFactorOtp(ts, tpl?)` — `twoFactor` plugin
- `senders.changeEmail(ts, tpl?)` — `user.changeEmail`
- `senders.deleteAccount(ts, tpl?)` — `user.deleteUser`
- `senders.invitation(ts, { inviteUrl, ... })` — `organization` plugin

## Custom templates

Each sender takes an optional template to override subject and body:

```ts
senders.verification(ts, {
  subject: (p) => `Confirm ${p.user.email}`,
  html: (p) => `<a href="${p.url}">Verify</a>`,
  text: (p) => `Verify: ${p.url}`,
  tag: 'auth.verify',
});
```

## Security notifications

`tinysendPlugin({ client })` emails the user after events better-auth has no
built-in callback for: password changed, email changed, 2FA enabled/disabled.
These never block the auth operation — failures go to `onError`. Toggle per
event with `events: { passwordChanged: false }`.

## License

MIT — a [system operator](https://systemoperator.com) product.
