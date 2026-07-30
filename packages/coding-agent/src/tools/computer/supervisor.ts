import type { DesktopAction, DesktopCapabilities, DesktopCapture, DesktopSessionOptions } from "@oh-my-pi/pi-natives";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { ToolAbortError, ToolError } from "../tool-errors";
import {
	COMPUTER_WORKER_ARG,
	type ComputerWorkerError,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
} from "./protocol";

const START_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 1_500;
const SMOKE_TIMEOUT_MS = 5_000;

export interface ComputerController {
	readonly capabilities: DesktopCapabilities | undefined;
	execute(actions: DesktopAction[], signal?: AbortSignal): Promise<DesktopCapture>;
	close(): Promise<void>;
}

export interface ComputerWorkerHandle {
	send(message: ComputerWorkerInbound): void;
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

export interface ComputerSupervisorTimeouts {
	startMs: number;
	closeMs: number;
}

const DEFAULT_TIMEOUTS: ComputerSupervisorTimeouts = {
	startMs: START_TIMEOUT_MS,
	closeMs: CLOSE_TIMEOUT_MS,
};
export type ComputerWorkerFactory = () => ComputerWorkerHandle;

function workerError(error: ComputerWorkerError): Error {
	const result = new ToolError(error.message);
	result.name = error.name;
	if (error.stack) result.stack = error.stack;
	return result;
}

function wrapWorker(worker: Worker): ComputerWorkerHandle {
	return {
		send(message) {
			worker.postMessage(message);
		},
		onMessage(handler) {
			const listener = (event: MessageEvent): void => handler(event.data as ComputerWorkerOutbound);
			worker.addEventListener("message", listener);
			return () => worker.removeEventListener("message", listener);
		},
		onError(handler) {
			const listener = (event: ErrorEvent): void =>
				handler(event.error instanceof Error ? event.error : new Error(event.message));
			worker.addEventListener("error", listener);
			return () => worker.removeEventListener("error", listener);
		},
		async terminate() {
			worker.terminate();
		},
	};
}

export function spawnComputerWorker(): ComputerWorkerHandle {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [COMPUTER_WORKER_ARG] })
		: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
	return wrapWorker(worker);
}

interface PendingRequest {
	resolve(capture: DesktopCapture): void;
	reject(error: unknown): void;
}

export class ComputerSupervisor implements ComputerController {
	#worker?: ComputerWorkerHandle;
	#startPromise?: Promise<void>;
	#capabilities?: DesktopCapabilities;
	#pending = new Map<string, PendingRequest>();
	#nextId = 0;
	#serial: Promise<void> = Promise.resolve();
	#closed = false;
	#unsubscribeMessage?: () => void;
	#unsubscribeError?: () => void;

	constructor(
		private readonly options: DesktopSessionOptions,
		private readonly createWorker: ComputerWorkerFactory = spawnComputerWorker,
		private readonly timeouts: ComputerSupervisorTimeouts = DEFAULT_TIMEOUTS,
	) {}

	get capabilities(): DesktopCapabilities | undefined {
		return this.#capabilities;
	}

	execute(actions: DesktopAction[], signal?: AbortSignal): Promise<DesktopCapture> {
		if (this.#closed) return Promise.reject(new ToolError("Computer session is closed"));
		const run = (): Promise<DesktopCapture> => this.#execute(actions, signal);
		const result = this.#serial.then(run, run);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #execute(actions: DesktopAction[], signal?: AbortSignal): Promise<DesktopCapture> {
		if (this.#closed) throw new ToolError("Computer session is closed");
		if (signal?.aborted) throw new ToolAbortError();
		await this.#start();
		if (signal?.aborted) throw new ToolAbortError();
		const id = `computer-${++this.#nextId}`;
		const request = Promise.withResolvers<DesktopCapture>();
		this.#pending.set(id, request);
		this.#worker!.send({ type: "execute", id, actions });
		if (!signal) return request.promise;

		const aborted = Promise.withResolvers<never>();
		const onAbort = (): void => aborted.reject(new ToolAbortError());
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([request.promise, aborted.promise]);
		} catch (error) {
			if (error instanceof ToolAbortError) await this.#terminate(error);
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#start(): Promise<void> {
		if (this.#startPromise) return this.#startPromise;
		const ready = Promise.withResolvers<void>();
		try {
			logger.debug("Starting native computer worker", {
				backend: this.options.backend,
				display: this.options.display,
				maxWidth: this.options.maxWidth,
				maxHeight: this.options.maxHeight,
			});
			const worker = this.createWorker();
			this.#worker = worker;
			this.#unsubscribeMessage = worker.onMessage(message => {
				if (message.type === "ready") {
					this.#capabilities = message.capabilities;
					logger.debug("Native computer worker ready", {
						backend: message.capabilities.backend,
						capturePermission: message.capabilities.capturePermission,
						inputPermission: message.capabilities.inputPermission,
						displayCount: message.capabilities.displayCount,
					});
					ready.resolve();
					return;
				}
				if (message.type === "result") {
					this.#capabilities = message.capabilities;
					const pending = this.#pending.get(message.id);
					this.#pending.delete(message.id);
					pending?.resolve(message.capture);
					logger.debug("Native computer capture completed", {
						requestId: message.id,
						backend: message.capture.backend,
						capturePermission: message.capture.capturePermission,
						inputPermission: message.capture.inputPermission,
						width: message.capture.width,
						height: message.capture.height,
					});
					return;
				}
				if (message.type === "error") {
					const error = workerError(message.error);
					logger.warn("Native computer worker request failed", {
						requestId: message.id,
						errorName: message.error.name,
					});
					if (message.id) {
						const pending = this.#pending.get(message.id);
						this.#pending.delete(message.id);
						pending?.reject(error);
					} else {
						ready.reject(error);
					}
				}
			});
			this.#unsubscribeError = worker.onError(error => {
				ready.reject(error);
				void this.#terminate(error);
			});
			worker.send({ type: "init", options: this.options });
		} catch (error) {
			ready.reject(error);
		}
		this.#startPromise = withTimeout(
			ready.promise,
			this.timeouts.startMs,
			"Timed out starting native computer worker",
		).catch(async error => {
			await this.#terminate(error);
			throw error;
		});
		return this.#startPromise;
	}

	async #terminate(reason: unknown): Promise<void> {
		logger.debug("Terminating native computer worker", {
			reason: reason instanceof Error ? reason.name : typeof reason,
		});
		const worker = this.#worker;
		this.#worker = undefined;
		this.#startPromise = undefined;
		this.#capabilities = undefined;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = undefined;
		this.#unsubscribeError?.();
		this.#unsubscribeError = undefined;
		for (const pending of this.#pending.values()) pending.reject(reason);
		this.#pending.clear();
		await worker?.terminate();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const worker = this.#worker;
		if (!worker) return;
		const closed = Promise.withResolvers<void>();
		const unsubscribe = worker.onMessage(message => {
			if (message.type === "closed") closed.resolve();
		});
		try {
			worker.send({ type: "close" });
			await withTimeout(closed.promise, this.timeouts.closeMs, "Timed out closing native computer worker");
		} catch {
			// Forced termination below is the bounded close fallback.
		} finally {
			unsubscribe();
			await this.#terminate(new ToolError("Computer session closed"));
		}
	}
}

const ownedSupervisors = new Map<string, Set<ComputerController>>();

export function registerComputerController(ownerId: string | undefined, controller: ComputerController): () => void {
	if (!ownerId) return () => {};
	const controllers = ownedSupervisors.get(ownerId) ?? new Set<ComputerController>();
	controllers.add(controller);
	ownedSupervisors.set(ownerId, controllers);
	return () => {
		controllers.delete(controller);
		if (controllers.size === 0) ownedSupervisors.delete(ownerId);
	};
}

export async function releaseComputerSessionsForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	const controllers = ownedSupervisors.get(ownerId);
	if (!controllers) return;
	ownedSupervisors.delete(ownerId);
	await Promise.allSettled(Array.from(controllers, controller => controller.close()));
}

export async function smokeTestComputerWorker(
	timeoutMs = SMOKE_TIMEOUT_MS,
	createWorker: ComputerWorkerFactory = spawnComputerWorker,
): Promise<void> {
	const worker = createWorker();
	const exchange = async (
		message: ComputerWorkerInbound,
		expected: ComputerWorkerOutbound["type"],
		failureMessage: string,
	): Promise<void> => {
		const response = Promise.withResolvers<void>();
		const unsubscribeMessage = worker.onMessage(received => {
			if (received.type === expected) response.resolve();
			else if (received.type === "error") response.reject(workerError(received.error));
		});
		const unsubscribeError = worker.onError(error => response.reject(error));
		try {
			worker.send(message);
			await withTimeout(response.promise, timeoutMs, failureMessage);
		} finally {
			unsubscribeMessage();
			unsubscribeError();
		}
	};

	try {
		await exchange(
			{ type: "init", options: { backend: "auto", display: "all", maxWidth: 1920, maxHeight: 1200 } },
			"ready",
			"Computer worker smoke initialization timed out",
		);
		await exchange({ type: "close" }, "closed", "Computer worker smoke close timed out");
	} finally {
		await worker.terminate();
	}
}
