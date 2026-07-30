import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";
import type { ComputerWorkerInbound, ComputerWorkerTransport } from "./protocol";
import { ComputerWorkerCore } from "./worker";

export function startComputerWorker(): void {
	if (!parentPort) throw new Error("computer-worker-entry: missing parentPort");

	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: ComputerWorkerTransport = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ComputerWorkerInbound));
			const listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};

	new ComputerWorkerCore(transport);
}

// Bun workers report `import.meta.main === false`. The source fallback still
// enters this file directly, while packaged CLI workers carry the selector and
// start the named entry only after installing its inbox.
if (!Bun.isMainThread && !process.argv.some(isWorkerHostSelector) && import.meta.path === Bun.main) {
	startComputerWorker();
}
