/**
 * Session dispatch scope (dsh's `scopeTarget` + Cordis `Context.filter`).
 *
 * A session registers listeners on its own tagged context. Dispatch passes a
 * carrier as the event subject, and Cordis consults `carrier[Context.filter]`
 * for every listener: untagged listeners (instance/host scope) receive every
 * event, tagged listeners receive only their own session. Without this, two
 * live sessions sharing one event bus would see each other's events — the
 * constraint that currently forces one runtime per session.
 *
 * The active scope also travels in an `AsyncLocalStorage`, because `ctx.session`
 * is read inside a handler and the API object is shared by every session of a
 * runtime: the handler must see the scope of the dispatch that called it, not
 * the last scope the runtime opened.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Context } from "@deepseek-ai/cordis";
import type { ExtensionSessionScope } from "./types";

/** Tag that marks a listener context as owned by one session. */
export const SESSION_SCOPE_TAG: unique symbol = Symbol("musepi.sessionScope");

const activeScope = new AsyncLocalStorage<ExtensionSessionScope>();

/** The session scope of the dispatch currently running, if any. */
export function currentSessionScope(): ExtensionSessionScope | undefined {
	return activeScope.getStore();
}

/** Run `fn` with `scope` visible to `currentSessionScope()` and to nested awaits. */
export function runInSessionScope<T>(scope: ExtensionSessionScope | undefined, fn: () => T): T {
	return scope === undefined ? fn() : activeScope.run(scope, fn);
}

/**
 * The dispatch subject that routes events to one session.
 *
 * Cordis reads `thisArg?.[Context.filter]` on every dispatch and drops listeners
 * whose context was tagged with a different session. Untagged listeners stay
 * global, which is what instance- and host-scope plugins rely on.
 */
export function sessionCarrier(key: object): object {
	return {
		[Context.filter](listenerContext: unknown): boolean {
			const tag = (listenerContext as Record<symbol, unknown> | undefined)?.[SESSION_SCOPE_TAG];
			return tag === undefined || tag === key;
		},
	};
}
