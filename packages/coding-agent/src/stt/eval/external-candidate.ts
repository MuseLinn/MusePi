import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import type { ReadableStreamDefaultReader } from "stream/web";
import type { CandidateRequest, CandidateResult, SpeechCandidate } from "./candidate";

interface ExternalCandidateOptions {
	implementation: string;
	python: string;
	workDir: string;
	bridgePath?: string;
}

class ExternalCandidate implements SpeechCandidate {
	readonly #options: ExternalCandidateOptions;
	#proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	#stderrTask: Promise<void> = Promise.resolve();
	#stderr = "";
	#inputBuffer = "";
	#inputEnded = false;
	#queue: Promise<void> = Promise.resolve();
	#prepared: { loadMs: number; rssBytes: number } | null = null;
	#closed = false;

	constructor(options: ExternalCandidateOptions) {
		this.#options = options;
	}

	prepare(): Promise<{ loadMs: number; rssBytes: number }> {
		return this.#enqueue(async () => {
			if (this.#prepared) return this.#prepared;
			await this.#spawn();
			const response = await this.#request({ type: "prepare" });
			if (
				response.type !== "prepare" ||
				typeof response.loadMs !== "number" ||
				typeof response.rssBytes !== "number"
			) {
				throw new Error("Invalid candidate prepare response");
			}
			this.#prepared = { loadMs: response.loadMs, rssBytes: response.rssBytes };
			return this.#prepared;
		});
	}

	extract(request: CandidateRequest): Promise<CandidateResult> {
		return this.#enqueue(async () => {
			if (!this.#prepared) throw new Error("Candidate is not prepared");
			const response = await this.#request({ type: "extract", ...request });
			if (response.id !== request.id)
				throw new Error(`Candidate returned unknown response id ${String(response.id)}`);
			if (
				(response.audioPath !== null && typeof response.audioPath !== "string") ||
				typeof response.sampleRate !== "number" ||
				typeof response.loadMs !== "number" ||
				typeof response.inferenceMs !== "number" ||
				typeof response.rssBytes !== "number"
			) {
				throw new Error("Invalid candidate result response");
			}
			return {
				id: request.id,
				audioPath: response.audioPath,
				sampleRate: response.sampleRate,
				loadMs: response.loadMs,
				inferenceMs: response.inferenceMs,
				...(typeof response.endpointMs === "number" ? { endpointMs: response.endpointMs } : {}),
				rssBytes: response.rssBytes,
			};
		});
	}

	#closePromise: Promise<void> | null = null;

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		this.#closed = true;
		const proc = this.#proc;
		if (proc) {
			try {
				proc.stdin.end();
			} catch {}
			if (proc.exitCode === null) proc.kill();
			await proc.exited.catch(() => {});
		}
		await this.#queue;
		await this.#stderrTask;
		this.#proc = null;
		this.#reader = null;
	}

	async #spawn(): Promise<void> {
		await fs.mkdir(this.#options.workDir, { recursive: true });
		const bridgePath =
			this.#options.bridgePath ?? path.join(import.meta.dir, "../../../scripts/speech-frontend-candidate.py");
		this.#proc = Bun.spawn({
			cmd: [this.#options.python, "-u", bridgePath, "--implementation", this.#options.implementation],
			cwd: this.#options.workDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#reader = this.#proc.stdout.getReader();
		this.#stderrTask = this.#drainStderr(this.#proc);
	}

	async #drainStderr(proc: Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const chunk of proc.stderr) {
				this.#stderr = `${this.#stderr}${decoder.decode(chunk, { stream: true })}`.slice(-16_384);
			}
		} catch {}
	}

	#enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#closed ? Promise.reject<T>(new Error("Candidate is closed")) : this.#queue.then(work, work);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
		const proc = this.#proc;
		if (!proc || proc.exitCode !== null) throw new Error("Candidate exited before receiving a request");
		try {
			proc.stdin.write(`${JSON.stringify(message)}\n`);
			await proc.stdin.flush();
			const line = await this.#readLine();
			try {
				const response = JSON.parse(line) as unknown;
				if (typeof response !== "object" || response === null) throw new Error("not an object");
				return response as Record<string, unknown>;
			} catch {
				throw new Error(`Invalid candidate response: ${line.slice(0, 200)}`);
			}
		} catch (error) {
			this.#closed = true;
			if (proc.exitCode === null) proc.kill();
			throw error;
		}
	}

	async #readLine(): Promise<string> {
		const reader = this.#reader;
		const proc = this.#proc;
		if (!reader || !proc) throw new Error("Candidate is closed");
		const decoder = new TextDecoder();
		while (true) {
			const newline = this.#inputBuffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.#inputBuffer.slice(0, newline).trim();
				this.#inputBuffer = this.#inputBuffer.slice(newline + 1);
				return line;
			}
			if (this.#inputEnded) {
				const code = await proc.exited;
				throw new Error(`Candidate exited with code ${code}${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`);
			}
			const next = await Promise.race([
				reader.read(),
				proc.exited.then(() => ({ done: true as const, value: undefined })),
			]);
			if (next.done) this.#inputEnded = true;
			else this.#inputBuffer += decoder.decode(next.value, { stream: true });
		}
	}
}

export function createExternalCandidate(options: ExternalCandidateOptions): SpeechCandidate {
	return new ExternalCandidate(options);
}
