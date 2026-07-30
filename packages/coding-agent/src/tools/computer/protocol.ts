import type { DesktopAction, DesktopCapabilities, DesktopCapture, DesktopSessionOptions } from "@oh-my-pi/pi-natives";

export const COMPUTER_WORKER_ARG = "__omp_worker_computer";

export type ComputerWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "init"; options: DesktopSessionOptions }
	| { type: "execute"; id: string; actions: DesktopAction[] }
	| { type: "close" };

export type ComputerWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "ready"; capabilities: DesktopCapabilities }
	| { type: "result"; id: string; capture: DesktopCapture; capabilities: DesktopCapabilities }
	| { type: "error"; id?: string; error: ComputerWorkerError }
	| { type: "closed" };

export interface ComputerWorkerError {
	name: string;
	message: string;
	stack?: string;
}

export interface ComputerWorkerTransport {
	send(message: ComputerWorkerOutbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void;
	close(): void;
}
