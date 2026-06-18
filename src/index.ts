/**
 * @tinysend/better-auth — auth emails through tinysend.
 *
 * Two parts:
 * - `senders.*` factories returning exactly the callback signatures better-auth
 *   expects (sendVerificationEmail, sendResetPassword, sendMagicLink, ...).
 *   These throw on failure so better-auth surfaces "could not send email".
 * - `tinysendPlugin()` — after-hooks for events better-auth has no callbacks
 *   for (password changed, email changed, 2FA toggled). Notification failures
 *   never block the auth operation; they go to onError.
 *
 * Zero dependency on the better-auth package: the exported shapes are
 * structurally compatible with its option and plugin types.
 */

import type { Tinysend } from 'tinysend';

interface AuthUser {
	id: string;
	email: string;
	name?: string | null;
}

export interface Template<P> {
	subject?: (params: P) => string;
	html?: (params: P) => string;
	text?: (params: P) => string;
	/** Tag stored on the email (defaults per sender, e.g. "auth.verification"). */
	tag?: string;
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function linkEmail(heading: string, body: string, url: string, cta: string): { html: string; text: string } {
	return {
		html: [
			`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">`,
			`<h2 style="margin:0 0 12px">${esc(heading)}</h2>`,
			`<p style="margin:0 0 20px;color:#444">${esc(body)}</p>`,
			`<p><a href="${esc(url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${esc(cta)}</a></p>`,
			`<p style="margin:20px 0 0;font-size:12px;color:#888">If the button does not work, copy this link:<br>${esc(url)}</p>`,
			`</div>`,
		].join(''),
		text: `${heading}\n\n${body}\n\n${url}\n`,
	};
}

function codeEmail(heading: string, body: string, code: string): { html: string; text: string } {
	return {
		html: [
			`<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">`,
			`<h2 style="margin:0 0 12px">${esc(heading)}</h2>`,
			`<p style="margin:0 0 20px;color:#444">${esc(body)}</p>`,
			`<p style="font-size:28px;letter-spacing:6px;font-weight:bold">${esc(code)}</p>`,
			`</div>`,
		].join(''),
		text: `${heading}\n\n${body}\n\n${code}\n`,
	};
}

interface SenderConfig<P> {
	defaultSubject: (params: P) => string;
	defaultBody: (params: P) => { html: string; text: string };
	tag: string;
	recipient: (params: P) => string;
}

function makeSender<P>(ts: Tinysend, from: string | undefined, config: SenderConfig<P>, tpl?: Template<P>) {
	return async (params: P): Promise<void> => {
		const subject = tpl?.subject ? tpl.subject(params) : config.defaultSubject(params);
		const defaults = tpl?.html || tpl?.text ? null : config.defaultBody(params);
		await ts.emails.send({
			from,
			to: config.recipient(params),
			subject,
			html: tpl?.html ? tpl.html(params) : defaults?.html,
			text: tpl?.text ? tpl.text(params) : defaults?.text,
			tag: tpl?.tag ?? config.tag,
		});
	};
}

// --- sender params (structurally match better-auth callback payloads) ---

export interface VerificationParams { user: AuthUser; url: string; token: string }
export interface ResetPasswordParams { user: AuthUser; url: string; token: string }
export interface MagicLinkParams { email: string; url: string; token: string }
export interface OtpParams { email: string; otp: string; type: 'sign-in' | 'email-verification' | 'forget-password' }
export interface TwoFactorOtpParams { user: AuthUser; otp: string }
export interface ChangeEmailParams { user: AuthUser; newEmail: string; url: string; token: string }
export interface DeleteAccountParams { user: AuthUser; url: string; token: string }
export interface InvitationParams {
	id: string;
	email: string;
	organization: { name: string };
	inviter: { user: AuthUser };
}

export interface SenderOptions {
	/** Sending address override — needed with a project-wide key, optional with a mailbox key. */
	from?: string;
}

export const senders = {
	/** emailVerification.sendVerificationEmail */
	verification: (ts: Tinysend, tpl?: Template<VerificationParams> & SenderOptions) =>
		makeSender<VerificationParams>(ts, tpl?.from, {
			recipient: (p) => p.user.email,
			defaultSubject: () => 'Verify your email address',
			defaultBody: (p) => linkEmail('Verify your email', 'Confirm your email address to finish setting up your account.', p.url, 'Verify email'),
			tag: 'auth.verification',
		}, tpl),

	/** emailAndPassword.sendResetPassword */
	reset: (ts: Tinysend, tpl?: Template<ResetPasswordParams> & SenderOptions) =>
		makeSender<ResetPasswordParams>(ts, tpl?.from, {
			recipient: (p) => p.user.email,
			defaultSubject: () => 'Reset your password',
			defaultBody: (p) => linkEmail('Reset your password', 'Someone requested a password reset for your account. If this was not you, ignore this email.', p.url, 'Reset password'),
			tag: 'auth.reset',
		}, tpl),

	/** magicLink plugin sendMagicLink */
	magicLink: (ts: Tinysend, tpl?: Template<MagicLinkParams> & SenderOptions) =>
		makeSender<MagicLinkParams>(ts, tpl?.from, {
			recipient: (p) => p.email,
			defaultSubject: () => 'Your sign-in link',
			defaultBody: (p) => linkEmail('Sign in', 'Click the button below to sign in. The link expires shortly.', p.url, 'Sign in'),
			tag: 'auth.magic-link',
		}, tpl),

	/** emailOTP plugin sendVerificationOTP (handles all three types) */
	otp: (ts: Tinysend, tpl?: Template<OtpParams> & SenderOptions) =>
		makeSender<OtpParams>(ts, tpl?.from, {
			recipient: (p) => p.email,
			defaultSubject: (p) =>
				p.type === 'sign-in' ? 'Your sign-in code'
				: p.type === 'forget-password' ? 'Your password reset code'
				: 'Your verification code',
			defaultBody: (p) => codeEmail('Your code', 'Enter this code to continue. It expires shortly.', p.otp),
			tag: 'auth.otp',
		}, tpl),

	/** twoFactor plugin otpOptions.sendOTP */
	twoFactorOtp: (ts: Tinysend, tpl?: Template<TwoFactorOtpParams> & SenderOptions) =>
		makeSender<TwoFactorOtpParams>(ts, tpl?.from, {
			recipient: (p) => p.user.email,
			defaultSubject: () => 'Your verification code',
			defaultBody: (p) => codeEmail('Verification code', 'Enter this code to complete sign-in.', p.otp),
			tag: 'auth.2fa-otp',
		}, tpl),

	/** user.changeEmail.sendChangeEmailVerification (sent to the current address) */
	changeEmail: (ts: Tinysend, tpl?: Template<ChangeEmailParams> & SenderOptions) =>
		makeSender<ChangeEmailParams>(ts, tpl?.from, {
			recipient: (p) => p.user.email,
			defaultSubject: () => 'Confirm your email change',
			defaultBody: (p) => linkEmail('Confirm email change', `Approve changing your account email to ${p.newEmail}. If this was not you, secure your account.`, p.url, 'Approve change'),
			tag: 'auth.change-email',
		}, tpl),

	/** user.deleteUser.sendDeleteAccountVerification */
	deleteAccount: (ts: Tinysend, tpl?: Template<DeleteAccountParams> & SenderOptions) =>
		makeSender<DeleteAccountParams>(ts, tpl?.from, {
			recipient: (p) => p.user.email,
			defaultSubject: () => 'Confirm account deletion',
			defaultBody: (p) => linkEmail('Delete your account', 'Confirm that you want to permanently delete your account. This cannot be undone.', p.url, 'Delete account'),
			tag: 'auth.delete-account',
		}, tpl),

	/** organization plugin sendInvitationEmail. inviteUrl builds the accept link from the invitation id. */
	invitation: (ts: Tinysend, opts: { inviteUrl: (data: InvitationParams) => string } & Template<InvitationParams> & SenderOptions) =>
		makeSender<InvitationParams>(ts, opts.from, {
			recipient: (p) => p.email,
			defaultSubject: (p) => `You've been invited to ${p.organization.name}`,
			defaultBody: (p) => linkEmail(
				`Join ${p.organization.name}`,
				`${p.inviter.user.name || p.inviter.user.email} invited you to join ${p.organization.name}.`,
				opts.inviteUrl(p),
				'Accept invitation',
			),
			tag: 'auth.invitation',
		}, opts),
};

// --- event notification plugin ---

export interface TinysendPluginOptions {
	client: Tinysend;
	/** Sending address — needed with a project-wide key, optional with a mailbox key. */
	from?: string;
	/** Which notifications to send. All on by default. */
	events?: {
		passwordChanged?: boolean;
		emailChanged?: boolean;
		twoFactor?: boolean;
	};
	/** Called when a notification send fails. Default: console.error. The auth operation is never blocked. */
	onError?: (err: unknown, ctx: { event: string; email?: string }) => void;
}

interface HookContext {
	path: string;
	context: {
		session?: { user?: AuthUser } | null;
		newSession?: { user?: AuthUser } | null;
	};
}

const NOTIFICATIONS: Array<{
	event: 'passwordChanged' | 'emailChanged' | 'twoFactor';
	paths: string[];
	subject: (path: string) => string;
	body: (path: string) => string;
	tag: string;
}> = [
	{
		event: 'passwordChanged',
		paths: ['/change-password', '/reset-password'],
		subject: () => 'Your password was changed',
		body: () => 'The password for your account was just changed. If this was not you, reset your password immediately.',
		tag: 'auth.password-changed',
	},
	{
		event: 'emailChanged',
		paths: ['/change-email'],
		subject: () => 'Your email address was changed',
		body: () => 'The email address on your account was just changed. If this was not you, contact support immediately.',
		tag: 'auth.email-changed',
	},
	{
		event: 'twoFactor',
		paths: ['/two-factor/enable', '/two-factor/disable'],
		subject: (path) => path.endsWith('/enable') ? 'Two-factor authentication enabled' : 'Two-factor authentication disabled',
		body: (path) => path.endsWith('/enable')
			? 'Two-factor authentication was enabled on your account.'
			: 'Two-factor authentication was disabled on your account. If this was not you, secure your account immediately.',
		tag: 'auth.2fa-changed',
	},
];

/**
 * better-auth plugin: security notifications for events that have no
 * built-in email callbacks. Structurally compatible with BetterAuthPlugin.
 */
export function tinysendPlugin(opts: TinysendPluginOptions) {
	const onError = opts.onError ?? ((err: unknown, ctx: { event: string }) =>
		console.error(`[tinysend/better-auth] ${ctx.event} notification failed:`, err));

	const active = NOTIFICATIONS.filter((n) => opts.events?.[n.event] !== false);
	const allPaths = active.flatMap((n) => n.paths);

	return {
		id: 'tinysend',
		hooks: {
			after: [
				{
					matcher: (ctx: HookContext) => allPaths.includes(ctx.path),
					handler: async (ctx: HookContext) => {
						const notification = active.find((n) => n.paths.includes(ctx.path));
						if (!notification) return;
						const user = ctx.context?.newSession?.user ?? ctx.context?.session?.user;
						if (!user?.email) return;
						try {
							const body = notification.body(ctx.path);
							await opts.client.emails.send({
								from: opts.from,
								to: user.email,
								subject: notification.subject(ctx.path),
								text: `${body}\n`,
								html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px"><p>${esc(body)}</p></div>`,
								tag: notification.tag,
							});
						} catch (err) {
							onError(err, { event: notification.event, email: user.email });
						}
					},
				},
			],
		},
	};
}
