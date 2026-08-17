import * as path from "node:path";

import { logger } from "@musepi/pi-utils";
import {
	attachSessionOwner,
	type CancelledErrorClass,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	resolveOwnerScopedSessionKey,
	type SessionOwners,
} from "./executor-base";

interface KernelSessionRegistryOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	bridge?: unknown;
	bridgeSessionId?: string;
}

interface RegistryKernelShutdownResult {
	confirmed?: boolean;
}

interface RegistryKernel {
	isAlive(): boolean;
	shutdown(options?: { timeoutMs: number }): Promise<RegistryKernelShutdownResult>;
}

export interface KernelSession<TKernel extends RegistryKernel> extends SessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: TKernel;
}

interface StartingKernelSession<TSession> extends SessionOwners {
	promise: Promise<TSession>;
}

export interface KernelSessionRegistryContext<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TSession extends KernelSession<TKernel>,
> {
	sessions: Map<string, TSession>;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	replaceSessionKernel: (session: TSession, cwd: string, options: TOptions) => Promise<TKernel>;
}

interface KernelSessionRegistryDescriptor<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TResult,
	TSession extends KernelSession<TKernel>,
> {
	languageLabel: string;
	cancelledErrorClass: CancelledErrorClass;
	buildSessionKey: (sessionId: string, cwd: string, interpreter: string | undefined) => string;
	createSession: (session: KernelSession<TKernel>) => TSession;
	startKernel: (cwd: string, options: TOptions) => Promise<TKernel>;
	executeWithKernel: (kernel: TKernel, code: string, options: TOptions) => Promise<TResult>;
	waitForStartup?: (promise: Promise<TSession>, options: TOptions) => Promise<TSession>;
	replaceSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	acquireLiveSessionKernel?: (
		session: TSession,
		cwd: string,
		options: TOptions,
		context: KernelSessionRegistryContext<TKernel, TOptions, TSession>,
	) => Promise<TKernel>;
	invalidateSession?: (session: TSession) => void;
	shutdownSession?: (session: TSession, resetting: boolean) => Promise<RegistryKernelShutdownResult>;
	clearResetsOnDisposeAll?: boolean;
	logBeforeReplacement?: boolean;
	isCancellation?: (error: unknown) => boolean;
	isTimedOutCancellation?: (error: unknown, signal?: AbortSignal) => boolean;
	validateKernel?: (session: TSession, kernel: TKernel) => boolean;
}

interface KernelSessionRegistry<TOptions extends KernelSessionRegistryOptions, TResult> {
	disposeAll(): Promise<void>;
	disposeByOwner(ownerId: string): Promise<void>;
	executeOnSession(code: string, cwd: string, options: TOptions): Promise<TResult>;
}

export function normalizeKernelSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

export function requireRemainingKernelTimeoutMs(
	deadlineMs: number | undefined,
	cancelledErrorClass: CancelledErrorClass,
): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new cancelledErrorClass(true);
	}
	return remainingMs;
}

export function formatSessionTimeoutAnnotation(timeoutMs?: number): string {
	if (timeoutMs === undefined) return "Command timed out";
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds`;
}

export function formatSessionKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const secs = timeoutMs === undefined ? undefined : Math.max(1, Math.round(timeoutMs / 1000));
	if (kernelKilled) {
		return "eval cell timed out and the kernel was unresponsive to interrupt; the kernel has been killed and will be recreated on the next call.";
	}
	const duration = secs === undefined ? "the configured timeout" : `${secs}s`;
	return `eval cell timed out after ${duration}; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`;
}

export function createKernelSessionRegistry<
	TKernel extends RegistryKernel,
	TOptions extends KernelSessionRegistryOptions,
	TResult,
	TSession extends KernelSession<TKernel>,
>(
	descriptor: KernelSessionRegistryDescriptor<TKernel, TOptions, TResult, TSession>,
): KernelSessionRegistry<TOptions, TResult> {
	const sessions = new Map<string, TSession>();
	const startingSessions = new Map<string, StartingKernelSession<TSession>>();
	const resettingSessions = new Map<string, Promise<void>>();

	const context: KernelSessionRegistryContext<TKernel, TOptions, TSession> = {
		sessions,
		startKernel: descriptor.startKernel,
		replaceSessionKernel,
	};

	function waitForStartup(promise: Promise<TSession>, options: TOptions): Promise<TSession> {
		return descriptor.waitForStartup?.(promise, options) ?? promise;
	}

	function isCurrent(session: TSession, kernel?: TKernel): boolean {
		return (
			sessions.get(session.sessionKey) === session &&
			(kernel === undefined || descriptor.validateKernel?.(session, kernel) !== false)
		);
	}

	async function acquireSession(
		sessionKey: string,
		sessionId: string,
		cwd: string,
		options: TOptions,
	): Promise<TSession> {
		const existing = sessions.get(sessionKey);
		if (existing) {
			attachSessionOwner(existing, sessionId, options.kernelOwnerId);
			return existing;
		}
		const starting = startingSessions.get(sessionKey);
		if (starting) {
			attachSessionOwner(starting, sessionId, options.kernelOwnerId);
			return await waitForStartup(starting.promise, options);
		}
		let startingSession!: StartingKernelSession<TSession>;
		const startup = (async () => {
			const kernel = await descriptor.startKernel(cwd, options);
			const session = descriptor.createSession({
				sessionKey,
				sessionId,
				cwd,
				kernel,
				ownerIds: new Set(startingSession.ownerIds),
				hasFallbackOwner: startingSession.hasFallbackOwner,
			});
			if (startingSessions.get(sessionKey) === startingSession) {
				sessions.set(sessionKey, session);
			}
			return session;
		})();
		startingSession = {
			ownerIds: new Set(),
			hasFallbackOwner: false,
			promise: startup,
		};
		attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
		startingSessions.set(sessionKey, startingSession);
		try {
			return await waitForStartup(startup, options);
		} finally {
			if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
		}
	}

	async function replaceSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.replaceSessionKernel) {
			return await descriptor.replaceSessionKernel(session, cwd, options, context);
		}
		if (descriptor.logBeforeReplacement) {
			logger.warn(`${descriptor.languageLabel} subprocess died or is unresponsive; spawning fresh process`, {
				sessionKey: session.sessionKey,
			});
		}
		const old = session.kernel;
		const remaining = getRemainingTimeoutMs(options.deadlineMs);
		await old
			.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
			.catch(() => undefined);
		if (sessions.get(session.sessionKey) !== session) {
			throw new descriptor.cancelledErrorClass(false);
		}
		requireRemainingKernelTimeoutMs(options.deadlineMs, descriptor.cancelledErrorClass);
		const next = await descriptor.startKernel(cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			await next.shutdown().catch(() => undefined);
			throw new descriptor.cancelledErrorClass(false);
		}
		session.kernel = next;
		return next;
	}

	async function acquireLiveSessionKernel(session: TSession, cwd: string, options: TOptions): Promise<TKernel> {
		if (descriptor.acquireLiveSessionKernel) {
			return await descriptor.acquireLiveSessionKernel(session, cwd, options, context);
		}
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		if (!session.kernel.isAlive()) await replaceSessionKernel(session, cwd, options);
		if (!isCurrent(session)) throw new descriptor.cancelledErrorClass(false);
		return session.kernel;
	}

	async function shutdownSession(session: TSession, resetting: boolean): Promise<RegistryKernelShutdownResult> {
		return await (descriptor.shutdownSession?.(session, resetting) ?? session.kernel.shutdown());
	}

	async function resetSession(sessionKey: string): Promise<void> {
		const existing =
			sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
		if (!existing) return;
		descriptor.invalidateSession?.(existing);
		sessions.delete(sessionKey);
		await shutdownSession(existing, true).catch(() => undefined);
	}

	async function disposeAll(): Promise<void> {
		const pending = [...startingSessions.values()].map(starting => starting.promise);
		startingSessions.clear();
		if (descriptor.clearResetsOnDisposeAll) resettingSessions.clear();
		const started = await Promise.allSettled(pending);
		const all = [...sessions.entries()];
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			if (!all.some(([, session]) => session === result.value)) {
				all.push([result.value.sessionKey, result.value]);
			}
		}
		for (const [id, session] of all) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(id) === session) sessions.delete(id);
		}
		const results = await Promise.allSettled(all.map(([, session]) => shutdownSession(session, false)));
		for (let i = 0; i < all.length; i += 1) {
			const [id, session] = all[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: id,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(id)) sessions.set(id, session);
		}
	}

	async function disposeByOwner(ownerId: string): Promise<void> {
		const toShutdown: TSession[] = [];
		const startingToShutdown: StartingKernelSession<TSession>[] = [];
		for (const session of [...sessions.values()]) {
			if (!session.ownerIds.has(ownerId)) continue;
			if (session.ownerIds.size === 1) {
				toShutdown.push(session);
				continue;
			}
			session.ownerIds.delete(ownerId);
		}
		for (const [sessionKey, starting] of [...startingSessions.entries()]) {
			if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
			if (starting.ownerIds.size === 1) {
				startingSessions.delete(sessionKey);
				startingToShutdown.push(starting);
				continue;
			}
			starting.ownerIds.delete(ownerId);
		}
		for (const session of toShutdown) {
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		}
		const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
		for (const result of started) {
			if (result.status !== "fulfilled") continue;
			const session = result.value;
			descriptor.invalidateSession?.(session);
			if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
			toShutdown.push(session);
		}
		const results = await Promise.allSettled(toShutdown.map(session => shutdownSession(session, false)));
		for (let i = 0; i < toShutdown.length; i += 1) {
			const session = toShutdown[i];
			const result = results[i];
			if (result.status === "fulfilled" && result.value?.confirmed !== false) {
				session.ownerIds.delete(ownerId);
				continue;
			}
			const reason = result.status === "rejected" ? result.reason : "not confirmed";
			logger.warn(`${descriptor.languageLabel} kernel shutdown not confirmed`, {
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				reason,
			});
			if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
		}
	}

	async function executeOnSession(code: string, cwd: string, options: TOptions): Promise<TResult> {
		const sessionId = options.sessionId ?? `session:${cwd}`;
		const sessionKey = resolveOwnerScopedSessionKey({
			baseKey: descriptor.buildSessionKey(sessionId, cwd, options.interpreter),
			ownerId: options.kernelOwnerId,
			reset: options.reset === true,
			hasSession: key => sessions.has(key) || startingSessions.has(key),
			getOwners: key => sessions.get(key) ?? startingSessions.get(key),
		});
		if (options.bridge && !options.bridgeSessionId) {
			options.bridgeSessionId = sessionId;
		}
		if (options.reset) {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
			else {
				const resetPromise = resetSession(sessionKey);
				resettingSessions.set(
					sessionKey,
					resetPromise.then(() => undefined),
				);
				try {
					await resetPromise;
				} finally {
					resettingSessions.delete(sessionKey);
				}
			}
		} else {
			const inFlight = resettingSessions.get(sessionKey);
			if (inFlight) await inFlight.catch(() => undefined);
		}
		const session = await acquireSession(sessionKey, sessionId, cwd, options);
		if (options.signal?.aborted) {
			const timedOut =
				descriptor.isTimedOutCancellation?.(options.signal.reason, options.signal) ??
				isTimedOutCancellation(options.signal.reason, descriptor.cancelledErrorClass, options.signal);
			throw new descriptor.cancelledErrorClass(timedOut);
		}
		const kernel = await acquireLiveSessionKernel(session, cwd, options);
		if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
		const runOptions = { ...options, cwd };
		try {
			return await descriptor.executeWithKernel(kernel, code, runOptions);
		} catch (err) {
			if (
				descriptor.isCancellation?.(err) ||
				isCancellationError(err, descriptor.cancelledErrorClass) ||
				options.signal?.aborted
			)
				throw err;
			if (kernel.isAlive()) throw err;
			let retryKernel: TKernel;
			if (descriptor.acquireLiveSessionKernel) {
				retryKernel = await acquireLiveSessionKernel(session, cwd, options);
			} else {
				if (!isCurrent(session, kernel)) throw new descriptor.cancelledErrorClass(false);
				retryKernel = await replaceSessionKernel(session, cwd, options);
			}
			if (!isCurrent(session, retryKernel)) throw new descriptor.cancelledErrorClass(false);
			return await descriptor.executeWithKernel(retryKernel, code, runOptions);
		}
	}

	return { disposeAll, disposeByOwner, executeOnSession };
}
