/**
 * @tinysend/better-auth — the tinysend audience plugin.
 *
 * Syncs your better-auth users into a tinysend list as consented subscribers,
 * maps user attributes onto the tinysend contact (tags + metadata + org/title),
 * sends account-security notifications, and propagates unsubscribes back into
 * better-auth via a webhook. Modeled on the better-auth-attio-plugin shape:
 * schema + init/databaseHooks + endpoints + hooks, `satisfies BetterAuthPlugin`.
 */

import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, createAuthMiddleware, sessionMiddleware } from 'better-auth/api';
import { Tinysend } from 'tinysend';
import { esc } from './senders.js';

interface PluginUser {
	id: string;
	email: string;
	name?: string | null;
	tinysendSubscriberId?: string | null;
	newsletterStatus?: string | null;
}

/** What to push onto the tinysend contact for a user. All additive on tinysend's side. */
export interface ContactMapping {
	tags?: string[];
	metadata?: Record<string, unknown>;
	org?: string;
	jobTitle?: string;
}

export interface TinysendOptions {
	/** tinysend API key (sk_...). Required. */
	apiKey: string;
	/** The list users are subscribed to (lst_...). Required. */
	listId: string;
	/** Public base URL of your app, used to register the unsubscribe webhook. Required. */
	appUrl: string;
	/** Opt-in mode. "double" (default) sends a tinysend confirmation email; "single" subscribes immediately (use only with explicit consent). */
	optIn?: 'double' | 'single';
	/** Auto-subscribe new users on sign-up. Default true. */
	subscribeOnSignup?: boolean;
	/** Sending address; optional with a mailbox key. */
	from?: string;
	/** Map a user to contact attributes synced to tinysend (tags, metadata, org/title). */
	mapContact?: (user: PluginUser) => ContactMapping;
	/** Security notifications via hooks (password/email/2FA changed). All on by default; pass false to disable. */
	notifications?: { passwordChanged?: boolean; emailChanged?: boolean; twoFactor?: boolean } | false;
	/** Path the unsubscribe webhook is mounted at (under /api/auth). Default "/tinysend/webhook". */
	webhookPath?: string;
	/** Auto-create the tinysend webhook on first sync. Default true. */
	registerWebhook?: boolean;
	/** Defer sync until after the response (edge runtimes). */
	waitUntil?: (promise: Promise<unknown>) => void;
	/** Called on any sync/send failure. The auth operation is never blocked. */
	onError?: (err: unknown, ctx: { op: string; email?: string }) => void;
}

const NOTIFICATIONS = [
	{
		event: 'passwordChanged' as const,
		paths: ['/change-password', '/reset-password'],
		subject: () => 'Your password was changed',
		body: () => 'The password for your account was just changed. If this was not you, reset your password immediately.',
		tag: 'auth.password-changed',
	},
	{
		event: 'emailChanged' as const,
		paths: ['/change-email'],
		subject: () => 'Your email address was changed',
		body: () => 'The email address on your account was just changed. If this was not you, contact support immediately.',
		tag: 'auth.email-changed',
	},
	{
		event: 'twoFactor' as const,
		paths: ['/two-factor/enable', '/two-factor/disable'],
		subject: (path: string) => (path.endsWith('/enable') ? 'Two-factor authentication enabled' : 'Two-factor authentication disabled'),
		body: (path: string) =>
			path.endsWith('/enable')
				? 'Two-factor authentication was enabled on your account.'
				: 'Two-factor authentication was disabled on your account. If this was not you, secure your account immediately.',
		tag: 'auth.2fa-changed',
	},
];

async function hmacHex(secret: string, body: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const tinysend = (opts: TinysendOptions) => {
	const ts = new Tinysend(opts.apiKey);
	const optIn = opts.optIn ?? 'double';
	const subscribeOnSignup = opts.subscribeOnSignup ?? true;
	const webhookPath = opts.webhookPath ?? '/tinysend/webhook';
	const registerWebhook = opts.registerWebhook ?? true;
	const defer = opts.waitUntil ?? ((p: Promise<unknown>) => { void p; });
	const onError = opts.onError ?? ((err, c) => console.error(`[tinysend/better-auth] ${c.op} failed:`, err));
	const notifyEnabled = (event: 'passwordChanged' | 'emailChanged' | 'twoFactor') =>
		opts.notifications !== false && (opts.notifications?.[event] ?? true);
	const activeNotifs = NOTIFICATIONS.filter((n) => notifyEnabled(n.event));
	const notifPaths = activeNotifs.flatMap((n) => n.paths);

	/** Find-or-create the tinysend webhook so unsubscribes propagate back. Lazy, idempotent. */
	async function ensureWebhook(adapter: any): Promise<void> {
		if (registerWebhook === false) return;
		const existing = await adapter.findOne({ model: 'tinysendWebhook', where: [{ field: 'listId', value: opts.listId }] });
		if (existing) return;
		const res = await ts.webhooks.create({
			url: `${opts.appUrl.replace(/\/$/, '')}${webhookPath}`,
			events: ['subscriber.confirmed', 'subscriber.unsubscribed', 'subscriber.deleted'],
		});
		await adapter.create({ model: 'tinysendWebhook', data: { listId: opts.listId, webhookId: res.id, secret: res.secret } });
	}

	/** Subscribe a user to the list and return the new status + subscriber id. */
	async function subscribe(user: PluginUser): Promise<{ subscriberId: string; status: string }> {
		const m = opts.mapContact?.(user) ?? {};
		const sub = await ts.subscribers.create(opts.listId, {
			email: user.email,
			name: user.name ?? undefined,
			verified: optIn === 'single',
			tags: m.tags,
			metadata: m.metadata,
			org: m.org,
			job_title: m.jobTitle,
		});
		return { subscriberId: sub.id, status: optIn === 'single' ? 'subscribed' : 'pending' };
	}

	return {
		id: 'tinysend',
		schema: {
			user: {
				fields: {
					tinysendSubscriberId: { type: 'string', required: false, input: false },
					newsletterStatus: { type: 'string', required: false, input: false },
				},
			},
			tinysendWebhook: {
				fields: {
					listId: { type: 'string', required: true, unique: true },
					webhookId: { type: 'string', required: true },
					secret: { type: 'string', required: true },
				},
			},
		},
		init: (ctx: any) => ({
			options: {
				databaseHooks: {
					user: {
						create: {
							after: async (user: PluginUser) => {
								if (!subscribeOnSignup) return;
								defer(
									(async () => {
										await ensureWebhook(ctx.adapter);
										const { subscriberId, status } = await subscribe(user);
										await ctx.adapter.update({
											model: 'user',
											where: [{ field: 'id', value: user.id }],
											update: { tinysendSubscriberId: subscriberId, newsletterStatus: status },
										});
									})().catch((e) => onError(e, { op: 'signup-subscribe', email: user.email })),
								);
							},
						},
					},
				},
			},
		}),
		endpoints: {
			tinysendSubscribe: createAuthEndpoint(
				'/tinysend/subscribe',
				{ method: 'POST', use: [sessionMiddleware] },
				async (c: any) => {
					const user = c.context.session.user as PluginUser;
					try {
						await ensureWebhook(c.context.adapter);
						const { subscriberId, status } = await subscribe(user);
						await c.context.adapter.update({
							model: 'user',
							where: [{ field: 'id', value: user.id }],
							update: { tinysendSubscriberId: subscriberId, newsletterStatus: status },
						});
						return c.json({ status });
					} catch (e) {
						onError(e, { op: 'subscribe', email: user.email });
						return c.json({ status: 'error' }, { status: 502 });
					}
				},
			),
			tinysendUnsubscribe: createAuthEndpoint(
				'/tinysend/unsubscribe',
				{ method: 'POST', use: [sessionMiddleware] },
				async (c: any) => {
					const user = c.context.session.user as PluginUser;
					if (user.tinysendSubscriberId) {
						try {
							await ts.subscribers.update(opts.listId, user.tinysendSubscriberId, { status: 'unsubscribed' });
						} catch (e) {
							onError(e, { op: 'unsubscribe', email: user.email });
						}
					}
					await c.context.adapter.update({
						model: 'user',
						where: [{ field: 'id', value: user.id }],
						update: { newsletterStatus: 'unsubscribed' },
					});
					return c.json({ status: 'unsubscribed' });
				},
			),
			tinysendPreferences: createAuthEndpoint(
				'/tinysend/preferences',
				{ method: 'GET', use: [sessionMiddleware] },
				async (c: any) => {
					const user = c.context.session.user as PluginUser;
					return c.json({ status: user.newsletterStatus ?? 'none', listId: opts.listId });
				},
			),
			tinysendWebhook: createAuthEndpoint(
				'/tinysend/webhook',
				{ method: 'POST' },
				async (c: any) => {
					const row = await c.context.adapter.findOne({ model: 'tinysendWebhook', where: [{ field: 'listId', value: opts.listId }] });
					const raw = c.request ? await c.request.clone().text() : JSON.stringify(c.body ?? {});
					if (row?.secret) {
						const sig = c.request?.headers.get('x-tinysend-signature') ?? '';
						const expected = await hmacHex(row.secret, raw);
						if (!sig || sig !== expected) return c.json({ ok: false }, { status: 401 });
					}
					let evt: any;
					try { evt = JSON.parse(raw); } catch { return c.json({ ok: false }, { status: 400 }); }
					const subId = evt?.data?.subscriber?.id;
					const status =
						evt?.event === 'subscriber.confirmed' ? 'subscribed'
						: evt?.event === 'subscriber.unsubscribed' ? 'unsubscribed'
						: evt?.event === 'subscriber.deleted' ? 'none'
						: null;
					if (status && subId) {
						await c.context.adapter.update({
							model: 'user',
							where: [{ field: 'tinysendSubscriberId', value: subId }],
							update: { newsletterStatus: status },
						});
					}
					return c.json({ ok: true });
				},
			),
		},
		hooks:
			activeNotifs.length === 0
				? undefined
				: {
						after: [
							{
								matcher: (c: any) => notifPaths.includes(c.path),
								handler: createAuthMiddleware(async (c: any) => {
									const notif = activeNotifs.find((n) => n.paths.includes(c.path));
									if (!notif) return;
									const user = (c.context?.newSession?.user ?? c.context?.session?.user) as PluginUser | undefined;
									if (!user?.email) return;
									try {
										const body = notif.body(c.path);
										await ts.emails.send({
											from: opts.from,
											to: user.email,
											subject: notif.subject(c.path),
											text: `${body}\n`,
											html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px"><p>${esc(body)}</p></div>`,
											tag: notif.tag,
										});
									} catch (e) {
										onError(e, { op: 'notify', email: user.email });
									}
								}),
							},
						],
					},
	} satisfies BetterAuthPlugin;
};
