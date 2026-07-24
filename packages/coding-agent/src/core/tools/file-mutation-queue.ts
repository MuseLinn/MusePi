import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

// ── Mutation listeners (MusePi LSP deferred diagnostics) ───────────
// Notified after a queued mutation completes successfully, while the queue
// lock is still held (so listeners observe mutations in per-file order).
// A listener may return a promise to delay the tool result briefly (the
// LSP listener uses this to inline fast diagnostics into the very next
// provider request); promises are awaited with a hard cap.
export type FileMutationListener = (filePath: string) => void | Promise<void>;
const fileMutationListeners = new Set<FileMutationListener>();

/** Register a post-mutation listener. Returns a detach function. */
export function addFileMutationListener(listener: FileMutationListener): () => void {
	fileMutationListeners.add(listener);
	return () => {
		fileMutationListeners.delete(listener);
	};
}

function notifyFileMutationListeners(filePath: string): Promise<void> {
	const pending: Promise<void>[] = [];
	for (const listener of fileMutationListeners) {
		try {
			const result = listener(filePath);
			if (result instanceof Promise) pending.push(result);
		} catch {
			// A broken listener must never fail the mutation itself.
		}
	}
	if (pending.length === 0) return Promise.resolve();
	// Hard cap: listeners are expected to self-cap their fast path (the LSP
	// listener resolves after its inline diagnostics window), but a wedged
	// listener must never stall the mutation queue.
	return Promise.race([
		Promise.allSettled(pending).then(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, LISTENER_HARD_CAP_MS)),
	]);
}
const LISTENER_HARD_CAP_MS = 3000;

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		const result = await fn();
		await notifyFileMutationListeners(filePath);
		return result;
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
