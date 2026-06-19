/**
 * Client plugin — gives the better-auth client typed methods for the tinysend
 * endpoints: authClient.tinysend.subscribe() / .unsubscribe() / .preferences().
 */

import type { BetterAuthClientPlugin } from 'better-auth/client';
import type { tinysend } from './plugin.js';

export const tinysendClient = () =>
	({
		id: 'tinysend',
		$InferServerPlugin: {} as ReturnType<typeof tinysend>,
	}) satisfies BetterAuthClientPlugin;
