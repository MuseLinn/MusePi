import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";
import { getRadiusOrchestratorBaseUrl, isRadiusEnabled, radiusPresence } from "./radius.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	mkdirSync(dirname(socketPath), { recursive: true });
	if (isRadiusEnabled()) {
		await radiusPresence.start();
		console.log(`radius integration enabled: ${socketPath} -> ${getRadiusOrchestratorBaseUrl()}`);
	} else {
		console.log("radius integration disabled: set PI_RADIUS_API_KEY to enable");
	}
	const server = await startIpcServer(handleIpcRequest);
	console.log(`orchestrator listening on ${socketPath}`);

	let cleanedUp = false;
	const cleanup = () => {
		if (cleanedUp) {
			return;
		}
		cleanedUp = true;
		server.close();
		void radiusPresence.stop();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
	};

	const shutdown = (exitCode: number) => {
		cleanup();
		process.exit(exitCode);
	};

	process.on("SIGINT", () => shutdown(0));
	process.on("SIGTERM", () => shutdown(0));
	process.on("exit", cleanup);
	process.on("uncaughtException", (error) => {
		console.error(error);
		shutdown(1);
	});
	process.on("unhandledRejection", (reason) => {
		console.error(reason);
		shutdown(1);
	});

	await new Promise<void>(() => {
		// Keep the process alive until a signal or fatal error triggers shutdown.
	});
}
