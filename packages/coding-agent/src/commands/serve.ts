/**
 * `musepi serve` — start the MusePi daemon (unix socket JSON-RPC, see
 * daemon Phase 3). Prints the socket path and stays in the
 * foreground until interrupted.
 *
 * Options:
 *   --port <n>     also listen for browser JSON-RPC on ws://127.0.0.1:<n>
 *   --web-port <n> also serve the renderer bundle (desktop-web dist) on
 *                  http://127.0.0.1:<n> — the dsh-desktop-compat "runtime
 *                  serves the web renderer" half; the Electron compat shell
 *                  loadURLs this origin (MUSEPI_GUI_COMPAT_URL).
 */
import { Command, Flags } from "@musepi/pi-utils/cli";
import { startDaemon } from "../daemon/server";

export default class Serve extends Command {
	static description = "Start the MusePi daemon (unix socket JSON-RPC)";
	static flags = {
		port: Flags.integer({ description: "WebSocket port for browser GUI connections" }),
		"web-port": Flags.integer({
			description: "HTTP port serving the renderer bundle (compat shell target)",
		}),
		"remote-token": Flags.string({
			description:
				"Enable remote connections: bind the WS to all interfaces and require this bearer token (Authorization: Bearer, or ?token= for browsers). NEVER share this token.",
		}),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Serve);
		const wsPort = flags.port;
		if (wsPort !== undefined && (wsPort < 1 || wsPort > 65535)) {
			throw new Error(`Invalid --port: ${wsPort}`);
		}
		const webPort = flags["web-port"];
		if (webPort !== undefined && (webPort < 0 || webPort > 65535)) {
			throw new Error(`Invalid --web-port: ${webPort}`);
		}
		const remoteToken = flags["remote-token"];
		if (remoteToken !== undefined && remoteToken.length < 16) {
			throw new Error("--remote-token must be at least 16 characters");
		}
		const { socketPath, wsPort: boundWsPort, webUrl, close } = await startDaemon({ wsPort, webPort, remoteToken });
		process.stdout.write(`musepi daemon listening on ${socketPath}\n`);
		if (boundWsPort) {
			process.stdout.write(
				remoteToken
					? `browser GUI: ws://0.0.0.0:${boundWsPort} (remote, token required)\n`
					: `browser GUI: ws://127.0.0.1:${boundWsPort}\n`,
			);
		}
		if (webUrl) {
			process.stdout.write(`renderer (compat shell): ${webUrl}\n`);
		}
		process.stdout.write("press Ctrl+C to stop\n");

		const shutdown = async (signal: string): Promise<void> => {
			process.stdout.write(`\nreceived ${signal}, shutting down…\n`);
			await close();
			process.exit(0);
		};
		process.on("SIGINT", () => void shutdown("SIGINT"));
		process.on("SIGTERM", () => void shutdown("SIGTERM"));

		// Keep the process alive; the socket server does not hold the loop by itself.
		await new Promise<void>(() => {});
	}
}
