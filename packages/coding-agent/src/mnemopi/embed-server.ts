/**
 * Machine-shared mnemopi embedding server.
 *
 * One detached process per (model, cache dir) serves every MusePi process on
 * the machine, so the ONNX model is loaded once instead of once per process.
 * The server never loads onnxruntime itself: inference runs in the existing
 * `__omp_worker_mnemopi_embed` child, which is SIGKILLed on idle exit.
 *
 * Transport is newline-delimited JSON over a loopback TCP socket. The port and
 * a random token are published in a state file readable only by the owner.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { writeFileAtomically } from "../utils/atomic-file";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "./embed-protocol";

export const MNEMOPI_EMBED_SERVER_ARG = "__omp_worker_mnemopi_embed_server";

export const MNEMOPI_EMBED_SERVER_MODEL_ENV = "MUSEPI_MNEMOPI_EMBED_MODEL";
export const MNEMOPI_EMBED_SERVER_CACHE_ENV = "MUSEPI_MNEMOPI_EMBED_CACHE_DIR";
export const MNEMOPI_EMBED_SERVER_STATE_ENV = "MUSEPI_MNEMOPI_EMBED_STATE_FILE";
export const MNEMOPI_EMBED_SERVER_TAG_ENV = "MUSEPI_MNEMOPI_EMBED_TAG";
export const MNEMOPI_EMBED_SERVER_IDLE_ENV = "MUSEPI_MNEMOPI_EMBED_IDLE_MS";

const DEFAULT_IDLE_MS = 15 * 60 * 1_000;
const EMBED_WORKER_ARG = "__omp_worker_mnemopi_embed";

interface ServerState {
	port: number;
	token: string;
	tag: string;
	pid: number;
}

interface RequestLine {
	token?: string;
	type: "ping" | "shutdown" | "init" | "embed";
	id?: string;
	model?: string;
	cacheDir?: string;
	texts?: string[];
	batchSize?: number;
}

function env(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`missing ${name}`);
	return value;
}

export async function startMnemopiEmbedServerFromEnvironment(): Promise<void> {
	const model = env(MNEMOPI_EMBED_SERVER_MODEL_ENV);
	const cacheDir = process.env[MNEMOPI_EMBED_SERVER_CACHE_ENV] || undefined;
	const stateFile = env(MNEMOPI_EMBED_SERVER_STATE_ENV);
	const tag = env(MNEMOPI_EMBED_SERVER_TAG_ENV);
	const idleMs = Number.parseInt(process.env[MNEMOPI_EMBED_SERVER_IDLE_ENV] ?? "", 10) || DEFAULT_IDLE_MS;
	const token = crypto.randomUUID();

	const spawned = createWorkerSubprocess<MnemopiEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(EMBED_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "mnemopi embed subprocess",
	});
	const worker = createWorkerHandle<MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound>(spawned, message => {
		try {
			spawned.proc.send(message);
		} catch {
			// The child is gone; the server exits on its idle timer.
		}
	});

	const buffers = new WeakMap<Bun.Socket<undefined>, string>();
	const requests = new Map<string, Bun.Socket<undefined>>();
	let closed = false;
	let idleTimer: NodeJS.Timeout | undefined;

	const server = Bun.listen<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open() {},
			data(socket, chunk) {
				resetIdle();
				const buffered = (buffers.get(socket) ?? "") + chunk.toString();
				let start = 0;
				for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n", start)) {
					const line = buffered.slice(start, index);
					start = index + 1;
					if (line) handleLine(socket, line);
				}
				buffers.set(socket, buffered.slice(start));
			},
			close(socket) {
				for (const [id, target] of requests) if (target === socket) requests.delete(id);
				buffers.delete(socket);
			},
			error() {},
		},
	});

	function reply(socket: Bun.Socket<undefined>, message: unknown): void {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			// Connection closed between parse and reply.
		}
	}

	function handleLine(socket: Bun.Socket<undefined>, line: string): void {
		let request: RequestLine;
		try {
			request = JSON.parse(line) as RequestLine;
		} catch {
			return;
		}
		if (request.token !== token) {
			socket.end();
			return;
		}
		if (request.type === "ping") {
			reply(socket, { type: "pong", id: request.id, tag });
			return;
		}
		if (request.type === "shutdown") {
			void stop();
			return;
		}
		if (request.type !== "init" && request.type !== "embed") return;
		const id = request.id;
		if (!id) return;
		requests.set(id, socket);
		worker.send({
			type: request.type,
			id,
			model: request.model ?? model,
			cacheDir: request.cacheDir ?? cacheDir,
			texts: request.texts,
			batchSize: request.batchSize,
		} as MnemopiEmbedWorkerInbound);
	}

	worker.onMessage(message => {
		const id = "id" in message ? message.id : undefined;
		const target = id ? requests.get(id) : undefined;
		if (!target) return;
		if (message.type !== "log") requests.delete(id!);
		reply(target, message);
	});
	worker.onError(error => {
		for (const target of requests.values()) reply(target, { type: "error", id: "", error: error.message });
		requests.clear();
	});

	function resetIdle(): void {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => void stop(), idleMs);
		idleTimer.unref?.();
	}

	async function stop(): Promise<void> {
		if (closed) return;
		closed = true;
		if (idleTimer) clearTimeout(idleTimer);
		server.stop(true);
		await worker.terminate();
		await fs.promises.rm(stateFile, { force: true });
		process.exit(0);
	}

	process.once("SIGTERM", () => void stop());
	process.once("SIGINT", () => void stop());

	await fs.promises.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
	const state: ServerState = { port: server.port, token, tag, pid: process.pid };
	await writeFileAtomically(stateFile, JSON.stringify(state));
	resetIdle();
}
