import type { DesktopAction, DesktopCapture, DesktopSession, DesktopSessionOptions } from "@oh-my-pi/pi-natives";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";
import type { ComputerWorkerError, ComputerWorkerInbound, ComputerWorkerTransport } from "./protocol";

export interface NativeDesktopSession {
	readonly capabilities: DesktopSession["capabilities"];
	capture(): Promise<DesktopCapture>;
	execute(actions: DesktopAction[]): Promise<DesktopCapture>;
	close(): Promise<void>;
}

export type NativeDesktopSessionFactory = (options: DesktopSessionOptions) => NativeDesktopSession;

const COORDINATE_ACTIONS: ReadonlySet<DesktopAction["type"]> = new Set([
	"click",
	"double_click",
	"drag",
	"move",
	"scroll",
]);

function serializeError(error: unknown): ComputerWorkerError {
	if (error instanceof Error) {
		return { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) };
	}
	return { name: "Error", message: String(error) };
}

function captureTransfer(capture: DesktopCapture): Bun.Transferable[] {
	const buffer = capture.data.buffer;
	return buffer instanceof ArrayBuffer ? [buffer] : [];
}

export class ComputerWorkerCore {
	#session?: NativeDesktopSession;
	#hasReturnedFrame = false;
	#closed = false;
	#tail: Promise<void> = Promise.resolve();
	readonly #unsubscribe: () => void;

	constructor(
		private readonly transport: ComputerWorkerTransport,
		private readonly createSession: NativeDesktopSessionFactory = createDesktopSession,
	) {
		this.#unsubscribe = transport.onMessage(message => this.#onMessage(message));
	}

	#onMessage(message: ComputerWorkerInbound): void {
		if (message.type === "ping") {
			this.transport.send({ type: "pong", id: message.id });
			return;
		}
		if (message.type === "close") {
			this.#tail = this.#tail.then(() => this.#close());
			return;
		}
		if (message.type === "init") {
			this.#tail = this.#tail.then(() => this.#init(message.options));
			return;
		}
		this.#tail = this.#tail.then(() => this.#execute(message.id, message.actions));
	}

	async #init(options: DesktopSessionOptions): Promise<void> {
		if (this.#closed) return;
		if (this.#session) {
			this.transport.send({
				type: "error",
				error: { name: "Error", message: "Computer worker already initialized" },
			});
			return;
		}
		try {
			this.#session = this.createSession(options);
			this.#hasReturnedFrame = false;
			this.transport.send({ type: "ready", capabilities: this.#session.capabilities });
		} catch (error) {
			this.transport.send({ type: "error", error: serializeError(error) });
		}
	}

	async #execute(id: string, actions: DesktopAction[]): Promise<void> {
		const session = this.#session;
		if (!session) {
			this.transport.send({
				type: "error",
				id,
				error: { name: "Error", message: "Computer worker is not initialized" },
			});
			return;
		}
		try {
			if (!this.#hasReturnedFrame && actions.some(action => COORDINATE_ACTIONS.has(action.type))) {
				this.transport.send({
					type: "error",
					id,
					error: {
						name: "Error",
						message:
							"Coordinate computer actions require a screenshot returned to the provider; request a screenshot first",
					},
				});
				return;
			}
			const capture = await session.execute(actions);
			this.transport.send(
				{ type: "result", id, capture, capabilities: session.capabilities },
				captureTransfer(capture),
			);
			this.#hasReturnedFrame = true;
		} catch (error) {
			this.transport.send({ type: "error", id, error: serializeError(error) });
		}
	}

	async #close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#session?.close();
		} catch (error) {
			this.transport.send({ type: "error", error: serializeError(error) });
		} finally {
			this.#session = undefined;
			this.#hasReturnedFrame = false;
			this.#unsubscribe();
			this.transport.send({ type: "closed" });
			this.transport.close();
		}
	}
}
