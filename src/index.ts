/**
 * @tinysend/better-auth
 *
 * - `tinysend(opts)` — the audience plugin: syncs better-auth users into a
 *   tinysend list (tags + metadata + identity), security notifications, and
 *   unsubscribe propagation. A real `BetterAuthPlugin`.
 * - `senders` — email option adapters (verification/reset/magic-link/otp) that
 *   route better-auth's emails through tinysend.
 *
 * The client plugin lives at `@tinysend/better-auth/client`.
 */

export { tinysend } from './plugin.js';
export type { TinysendOptions, ContactMapping } from './plugin.js';
export * from './senders.js';
