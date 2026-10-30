import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SpeechCandidate } from "@musepi/pi-coding-agent/stt/eval/candidate";
import { createExternalCandidate } from "@musepi/pi-coding-agent/stt/eval/external-candidate";
import { removeWithRetries } from "@musepi/pi-utils";

const candidates = new Set<SpeechCandidate>();
let tmp = "";

afterEach(async () => {
	for (const candidate of candidates) await candidate.close().catch(() => {});
	candidates.clear();
	if (tmp) await removeWithRetries(tmp);
	tmp = "";
});

const FAKE_CANDIDATE = String.raw`
import json, os, sys, time
implementation = sys.argv[sys.argv.index("--implementation") + 1]
with open(os.path.join(os.getcwd(), "starts.txt"), "a", encoding="utf-8") as starts:
    starts.write(str(os.getpid()) + "\n")
with open(os.path.join(os.getcwd(), "pid.txt"), "w", encoding="utf-8") as pid:
    pid.write(str(os.getpid()))
for line in sys.stdin:
    request = json.loads(line)
    if request["type"] == "close":
        break
    if request["type"] == "prepare":
        print(json.dumps({"type": "prepare", "loadMs": 12, "rssBytes": 1000}), flush=True)
        continue
    if implementation == "exit":
        os._exit(23)
    if implementation == "malformed":
        print("not-json", flush=True)
        continue
    response_id = "different" if implementation == "unknown-id" else request["id"]
    print(json.dumps({
        "type": "result",
        "id": response_id,
        "audioPath": None if request["id"] == "reject" else request["mixturePath"],
        "sampleRate": 16000,
        "loadMs": 0,
        "inferenceMs": 5,
        "endpointMs": 7,
        "rssBytes": 2000
    }), flush=True)
`;

async function startCandidate(implementation = "passthrough"): Promise<{ candidate: SpeechCandidate; dir: string }> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-speech-candidate-"));
	const bridgePath = path.join(tmp, "fake-candidate.py");
	await Bun.write(bridgePath, FAKE_CANDIDATE);
	const candidate = createExternalCandidate({
		implementation,
		python: process.env.PYTHON ?? "python",
		workDir: tmp,
		bridgePath,
	});
	candidates.add(candidate);
	return { candidate, dir: tmp };
}

describe("external speech candidate", () => {
	it("serves multiple requests through one prepared process", async () => {
		const { candidate, dir } = await startCandidate();
		expect(await candidate.prepare()).toEqual({ loadMs: 12, rssBytes: 1000 });
		const first = await candidate.extract({ id: "first", mixturePath: "first.wav", enrollmentPaths: [] });
		const second = await candidate.extract({ id: "second", mixturePath: "second.wav", enrollmentPaths: [] });

		expect(first.audioPath).toBe("first.wav");
		expect(second.audioPath).toBe("second.wav");
		expect(first.loadMs).toBe(0);
		expect(first.endpointMs).toBe(7);
		expect(second.rssBytes).toBe(2000);
		const starts = await Bun.file(path.join(dir, "starts.txt")).text();
		expect(starts.trim().split(/\r?\n/)).toHaveLength(1);
	});

	it("returns null audio for an interferer-only rejection", async () => {
		const { candidate } = await startCandidate();
		await candidate.prepare();
		const result = await candidate.extract({ id: "reject", mixturePath: "other.wav", enrollmentPaths: [] });
		expect(result.audioPath).toBeNull();
		expect(result.sampleRate).toBe(16_000);
	});

	it("rejects malformed responses and prevents later requests from hanging", async () => {
		const { candidate } = await startCandidate("malformed");
		await candidate.prepare();
		const firstError = await candidate.extract({ id: "bad", mixturePath: "bad.wav", enrollmentPaths: [] }).then(
			() => null,
			error => error as Error,
		);
		expect(firstError?.message).toContain("Invalid candidate response");
		const laterError = await candidate.extract({ id: "later", mixturePath: "later.wav", enrollmentPaths: [] }).then(
			() => null,
			error => error as Error,
		);
		expect(laterError?.message).toContain("closed");
	});

	it("rejects responses with an unknown id", async () => {
		const { candidate } = await startCandidate("unknown-id");
		await candidate.prepare();
		const error = await candidate.extract({ id: "expected", mixturePath: "input.wav", enrollmentPaths: [] }).then(
			() => null,
			error => error as Error,
		);
		expect(error?.message).toContain("unknown response id");
	});

	it("rejects pending requests when the candidate exits", async () => {
		const { candidate } = await startCandidate("exit");
		await candidate.prepare();
		const error = await candidate.extract({ id: "exit", mixturePath: "input.wav", enrollmentPaths: [] }).then(
			() => null,
			error => error as Error,
		);
		expect(error?.message).toContain("exited");
	});

	it("reaps the child process on close", async () => {
		const { candidate, dir } = await startCandidate();
		await candidate.prepare();
		const pid = Number(await Bun.file(path.join(dir, "pid.txt")).text());
		await candidate.close();
		expect(() => process.kill(pid, 0)).toThrow();
		await candidate.close();
	});
});
