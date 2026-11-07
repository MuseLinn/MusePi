import * as fs from "node:fs";
import * as path from "node:path";
import { getFastembedCacheDir, getMnemopiEmbedRuntimeDir, logger, VERSION } from "@musepi/pi-utils";
import type { RefCountedWorkerHandle } from "../subprocess/worker-client";
import { resolveWorkerSpawnCmd } from "../subprocess/worker-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";
import {
	MNEMOPI_EMBED_SERVER_ARG,
	MNEMOPI_EMBED_SERVER_CACHE_ENV,
	MNEMOPI_EMBED_SERVER_IDLE_ENV,
	MNEMOPI_EMBED_SERVER_MODEL_ENV,
	MNEMOPI_EMBED_SERVER_STATE_ENV,
	MNEMOPI_EMBED_SERVER_TAG_ENV,
} from "./embed-server";

const CONNECT_TIMEOUT_MS = 3_000;
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 200;
const WORKER_CONNECTION_CLOSED = "mnemopi embed server connection closed";

interface ServerState {
	port: number;
	token: string;
	tag: string;
	pid: number;
}

type MessageHandler = (message: MnemopiEmbedWorkerOutbound) => void;
type ErrorHandler = (error: Error) => void;

function statePath(model: string, cacheDir: string): string {
	const key = `${model}-${Bun.hash.crc32(path.resolve(cacheDir)).toString(16).padStart(8, "0")}`;
	return path.join(getMnemopiEmbedRuntimeDir(), `${key}.json`);
}

async function readState(file: string): Promise<ServerState | undefined> {
	try {
		const value = (await Bun.file(file).json()) as Partial<ServerState>;
		if (
			typeof value.port === "number" &&
			typeof value.token === "string" &&
			typeof value.tag === "string" &&
			typeof value.pid === "number"
		) {
			return value as ServerState;
		}
	} catch {
		// Missing or half-written state: spawn or retry.
	}
	return undefined;
}

function spawnServer(model: string, cacheDir: string, stateFile: string): void {
	const command = resolveWorkerSpawnCmd(MNEMOPI_EMBED_SERVER_ARG);
	const logPath = `${stateFile}.log`;
	const logFd = fs.openSync(logPath, "a");
	try {
		const env: Record<string, string> = {
			...Object.fromEntries(
				Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			),
			[MNEMOPI_EMBED_SERVER_MODEL_ENV]: model,
			[MNEMOPI_EMBED_SERVER_CACHE_ENV]: cacheDir,
			[MNEMOPI_EMBED_SERVER_STATE_ENV]: stateFile,
			[MNEMOPI_EMBED_SERVER_TAG_ENV]: VERSION,
			[MNEMOPI_EMBED_SERVER_IDLE_ENV]: String(15 * 60 * 1_000),
		};
		const proc = Bun.spawn({
			cmd: command.cmd,
			cwd: command.cwd,
			env,
			stdio: ["ignore", logFd, logFd],
			detached: true,
		});
		proc.unref();
	} finally {
		fs.closeSync(logFd);
	}
}

async function waitForState(file: string, deadline: number): Promise<ServerState> {
	for (;;) {
		const state = await readState(file);
		if (state) return state;
		if (Date.now() >= deadline) throw new Error("mnemopi embed server did not publish its endpoint");
		await Bun.sleep(READY_POLL_MS);
	}
}

function createHandle(
	state: ServerState,
): RefCountedWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound> {
	const messageHandlers = new Set<MessageHandler>();
	const errorHandlers = new Set<ErrorHandler>();
	const queue: string[] = [];
	let socket: Bun.Socket<undefined> | undefined;
	let buffer = "";
	let closed = false;

	const fail = (error: Error) => {
		if (closed) return;
		closed = true;
		for (const handler of errorHandlers) handler(error);
	};

	const handle: RefCountedWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound> = {
		send(message) {
			const line = `${JSON.stringify({ ...message, token: state.token })}\n`;
			if (socket) socket.write(line);
			else queue.push(line);
		},
		onMessage(handler) {
			messageHandlers.add(handler);
			return () => messageHandlers.delete(handler);
		},
		onError(handler) {
			errorHandlers.add(handler);
			return () => errorHandlers.delete(handler);
		},
		async terminate() {
			closed = true;
			socket?.end();
			socket = undefined;
		},
		ref() {},
		unref() {},
	};

	void (async () => {
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("mnemopi embed server connect timed out")),
					CONNECT_TIMEOUT_MS,
				);
				void Bun.connect({
					hostname: "127.0.0.1",
					port: state.port,
					socket: {
						open(socket_) {
							clearTimeout(timer);
							socket = socket_;
							resolve();
						},
						data(_socket, chunk) {
							buffer += chunk.toString();
							let start = 0;
							for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n", start)) {
								const line = buffer.slice(start, index);
								start = index + 1;
								if (!line) continue;
								try {
									const message = JSON.parse(line) as MnemopiEmbedWorkerOutbound;
									for (const handler of messageHandlers) handler(message);
								} catch {
									// Malformed line: keep the connection and drop it.
								}
							}
							buffer = buffer.slice(start);
						},
						close() {
							fail(new Error(WORKER_CONNECTION_CLOSED));
						},
						error(_socket, error) {
							fail(error);
						},
					},
				}).catch(error => {
					clearTimeout(timer);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
				void timer;
			});
			for (const line of queue.splice(0)) socket?.write(line);
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	})();

	return handle;
}

/**
 * Reach the machine-shared embedding server for (model, cache dir), spawning
 * the detached server when no live one answers with this build's tag.
 *
 * Returns a transport that queues requests until the socket opens. Callers fall
 * back to a per-process worker when this rejects, so a shared server that
 * cannot start never disables local embeddings.
 */
export async function connectSharedMnemopiEmbedServer(
	model: string,
	cacheDir: string | undefined,
): Promise<RefCountedWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>> {
	const resolvedCache = cacheDir ?? getFastembedCacheDir();
	const file = statePath(model, resolvedCache);
	await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	let state = await readState(file);
	if (!state || state.tag !== VERSION) {
		spawnServer(model, resolvedCache, file);
		state = await waitForState(file, Date.now() + READY_TIMEOUT_MS);
	}
	logger.debug("mnemopi-embed: using shared server", { model, port: state.port });
	return createHandle(state);
}
