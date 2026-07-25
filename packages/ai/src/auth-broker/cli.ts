/**
 * `pi-ai auth-broker` CLI commands.
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the broker against the local SQLite store.
 *   - `token [--regenerate]` — print or regenerate the bearer token.
 *   - `status` — health-ping the configured remote broker.
 *   - `list` — list available providers.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteCredentialStore } from "../auth/sqlite-credential-store.ts";
import { SqliteBrokerStore } from "./broker-store.ts";
import { AuthBrokerClient } from "./client.ts";
import { resolveAuthBrokerConfig } from "./discover.ts";
import { startAuthBroker } from "./server.ts";

const MUSEPI_CONFIG_ROOT = process.env.MUSEPI_CONFIG_ROOT ?? join(homedir(), ".musepi");

function getTokenFilePath(): string {
	return join(MUSEPI_CONFIG_ROOT, "auth-broker.token");
}

function getDbPath(): string {
	return join(MUSEPI_CONFIG_ROOT, "broker.db");
}

async function readToken(): Promise<string | null> {
	const p = getTokenFilePath();
	try {
		const raw = readFileSync(p, "utf-8");
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

async function writeToken(token: string): Promise<void> {
	const p = getTokenFilePath();
	const dir = dirname(p);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(p, token + "\n", { mode: 0o600 });
}

function generateToken(): string {
	return randomBytes(32).toString("hex");
}

// ─── Command handlers ───────────────────────────────────────────────────────

interface CommandFlags {
	bind?: string;
	regenerate?: boolean;
	json?: boolean;
}

async function handleServe(flags: CommandFlags): Promise<void> {
	let token = await readToken();
	if (!token) {
		token = generateToken();
		await writeToken(token);
		console.error(`Generated broker token: ${token}`);
	}

	const store = new SqliteCredentialStore(getDbPath());
	const brokerStore = new SqliteBrokerStore({ store });

	const handle = await startAuthBroker({
		storage: brokerStore,
		bearerTokens: [token],
		bind: flags.bind ?? "127.0.0.1:8765",
	});

	console.error(`Auth-broker listening: ${handle.url}`);
	console.error(`Token file: ${getTokenFilePath()}`);

	const shutdown = async (signal: string): Promise<void> => {
		console.error(`\nShutting down (${signal})...`);
		await handle.close();
		store.close();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	await new Promise(() => {});
}

async function handleToken(flags: CommandFlags): Promise<void> {
	if (flags.regenerate) {
		const token = generateToken();
		await writeToken(token);
		if (flags.json) {
			console.log(JSON.stringify({ ok: true }));
		} else {
			console.log(token);
		}
		return;
	}

	const token = await readToken();
	if (!token) {
		if (flags.json) {
			console.log(JSON.stringify({ ok: false, reason: "no_token_file" }));
		} else {
			console.error("No broker token found. Use --regenerate to create one.");
			process.exit(1);
		}
		return;
	}

	if (flags.json) {
		console.log(JSON.stringify({ ok: true }));
	} else {
		console.log(token);
	}
}

async function handleStatus(flags: CommandFlags): Promise<void> {
	const config = resolveAuthBrokerConfig();
	if (!config) {
		if (flags.json) {
			console.log(JSON.stringify({ ok: false, reason: "not_configured" }));
		} else {
			console.error("No auth-broker configured (set MUSEPI_AUTH_BROKER_URL).");
			process.exit(1);
		}
		return;
	}

	const client = new AuthBrokerClient({ baseUrl: config.url, token: config.token });

	try {
		const health = await client.healthz();
		if (flags.json) {
			console.log(JSON.stringify({ ok: true, url: config.url }));
		} else {
			console.log(`Auth-broker: ${config.url}`);
			console.log(`Status: OK (v${health.version ?? "?"})`);
		}
	} catch (error) {
		if (flags.json) {
			console.log(JSON.stringify({ ok: false, url: config.url, error: String(error) }));
		} else {
			console.error(`Auth-broker: ${config.url}`);
			console.error(`Status: UNREACHABLE — ${String(error)}`);
			process.exit(1);
		}
	}
}

async function handleList(): Promise<void> {
	console.log("OAuth providers: anthropic, openai, google, github");
	console.log("API-key providers: any provider with apiKey config");
	console.log("\nUse `login <provider>` in the MusePi TUI or set MUSEPI_AUTH_BROKER_URL to use remote credentials.");
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export type AuthBrokerAction = "serve" | "token" | "status" | "list";

export async function runAuthBrokerCommand(
	action: AuthBrokerAction,
	rawFlags: Record<string, string | boolean> = {},
): Promise<void> {
	const flags: CommandFlags = {
		bind: typeof rawFlags.bind === "string" ? rawFlags.bind : undefined,
		regenerate: rawFlags.regenerate === true,
		json: rawFlags.json === true,
	};
	switch (action) {
		case "serve":
			await handleServe(flags);
			break;
		case "token":
			await handleToken(flags);
			break;
		case "status":
			await handleStatus(flags);
			break;
		case "list":
			await handleList();
			break;
		default:
			console.error("Usage: musepi auth-broker <serve|token|status|list> [flags]");
			console.error("  serve [--bind=host:port]    Start the broker server");
			console.error("  token [--regenerate]         Print or regenerate bearer token");
			console.error("  status                       Health-check configured remote broker");
			console.error("  list                         List available providers");
			process.exit(1);
	}
}

// Allow direct invocation
const thisFile = new URL(import.meta.url).pathname;
const isDirectInvocation =
	process.argv[1] === thisFile || process.argv[1]?.endsWith("/cli.ts") || process.argv[1]?.endsWith("\\cli.ts");

if (isDirectInvocation) {
	const action = process.argv[2] as AuthBrokerAction | undefined;
	if (!action || !["serve", "token", "status", "list"].includes(action)) {
		console.error("Usage: pi-ai auth-broker <serve|token|status|list> [flags]");
		console.error("  serve [--bind=host:port]    Start the broker server");
		console.error("  token [--regenerate]         Print or regenerate bearer token");
		console.error("  status                       Health-check configured remote broker");
		console.error("  list                         List available providers");
		process.exit(1);
	}

	const rawFlags: Record<string, string | boolean> = {};
	for (const arg of process.argv.slice(3)) {
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq !== -1) {
				rawFlags[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else {
				rawFlags[arg.slice(2)] = true;
			}
		}
	}

	runAuthBrokerCommand(action, rawFlags).catch((error) => {
		console.error("Fatal:", error);
		process.exit(1);
	});
}
