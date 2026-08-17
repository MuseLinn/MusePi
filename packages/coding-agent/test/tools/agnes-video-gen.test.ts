import { afterEach, describe, expect, it } from "bun:test";
import type { AsyncJobManager } from "@musepi/pi-coding-agent/async";
import type { CustomToolContext } from "@musepi/pi-coding-agent/extensibility/custom-tools";
import { agnesVideoGenTool } from "@musepi/pi-coding-agent/tools/agnes-video-gen";

const originalAgnesKey = Bun.env.AGNES_API_KEY;

afterEach(() => {
	if (originalAgnesKey === undefined) {
		delete Bun.env.AGNES_API_KEY;
	} else {
		Bun.env.AGNES_API_KEY = originalAgnesKey;
	}
	delete Bun.env.AGNES_GLOBAL_API_KEY;
});

interface CapturedJob {
	label: string;
	run: (ctx: {
		jobId: string;
		signal?: AbortSignal;
		reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
	}) => Promise<string>;
	options: Record<string, unknown>;
}

function createFakeJobManager(): { manager: AsyncJobManager; jobs: CapturedJob[] } {
	const jobs: CapturedJob[] = [];
	const fakeManager = {
		register: ((_type: string, label: string, run: CapturedJob["run"], options: Record<string, unknown>) => {
			jobs.push({ label, run, options });
			return `job-${jobs.length}`;
		}) as unknown as AsyncJobManager["register"],
	} as AsyncJobManager;
	return { manager: fakeManager, jobs };
}

function createContext(
	overrides: { manager?: AsyncJobManager; agentId?: string; fetch?: typeof fetch } = {},
): CustomToolContext {
	const { manager, agentId = "Main", fetch: fetchImpl } = overrides;
	return {
		sessionManager: {
			getSessionId: () => "s1",
			getCwd: () => "/tmp",
		} as CustomToolContext["sessionManager"],
		modelRegistry: {
			getApiKeyForProvider: async () => "test-agnes-key",
		} as unknown as CustomToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		asyncJobManager: manager,
		agentId,
		fetch: fetchImpl,
	};
}

const CREATE_RESPONSE = {
	id: "task_1",
	task_id: "task_1",
	video_id: "video_1",
	status: "queued",
	progress: 0,
	seconds: "3.4",
	size: "1088x832",
};

const COMPLETED_RESPONSE = {
	id: "video_1",
	status: "completed",
	progress: 100,
	seconds: "3.4",
	size: "1088x832",
	// Verified against the live API: the URL lives at the TOP LEVEL; metadata is null.
	url: "https://platform-outputs.example/videos/agnes-video-v2.0/video_1.mp4",
	metadata: null,
	size_mapping: {
		adjusted: true,
		resolution: "720p",
		ratio: "4:3",
		requested_width: 1152,
		requested_height: 768,
		width: 1088,
		height: 832,
		message: "Input size 1152x768 was mapped to nearest preset 720p/4:3 (1088x832)",
	},
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Standard mock: create + single completed status poll. Records request URLs. */
function createFetchMock(requestUrls: string[]): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = input.toString();
		requestUrls.push(url);
		if (url.includes("/v1/videos")) return jsonResponse(CREATE_RESPONSE);
		if (url.includes("/agnesapi")) return jsonResponse(COMPLETED_RESPONSE);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

describe("agnesVideoGenTool", () => {
	it("submits and returns immediately as a background job by default (wait not set)", async () => {
		const { manager, jobs } = createFakeJobManager();
		const requestUrls: string[] = [];
		const fetchMock = createFetchMock(requestUrls);

		const result = await agnesVideoGenTool.execute(
			"c1",
			{ prompt: "a cat walking" },
			undefined,
			createContext({ manager, fetch: fetchMock }),
			undefined,
		);

		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("backgrounded as job job-1");
		expect(text).toContain("result will be delivered automatically");
		expect(result.details).toMatchObject({
			taskId: "task_1",
			videoId: "video_1",
			status: "queued",
			async: { state: "running", jobId: "job-1", type: "agnes-video" },
		});
		// Only the create call happened — no polling inside execute.
		expect(requestUrls).toHaveLength(1);
		expect(requestUrls[0]).toContain("/v1/videos");
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.options).toEqual({ ownerId: "Main" });
		expect(jobs[0]?.label).toBe("a cat walking");
	});

	it("background job polls to completion and delivers the video URL text", async () => {
		const { manager, jobs } = createFakeJobManager();
		const requestUrls: string[] = [];
		const fetchMock = createFetchMock(requestUrls);

		await agnesVideoGenTool.execute(
			"c2",
			{ prompt: "a cat walking" },
			undefined,
			createContext({ manager, fetch: fetchMock }),
			undefined,
		);

		expect(jobs).toHaveLength(1);
		let deliveredText = "";
		let deliveredDetails: Record<string, unknown> | undefined;
		const text = await jobs[0]!.run({
			jobId: "job-1",
			signal: undefined,
			reportProgress: async (t, d) => {
				deliveredText = t;
				deliveredDetails = d;
			},
		});
		expect(text).toContain("URL: https://platform-outputs.example/videos/agnes-video-v2.0/video_1.mp4");
		expect(text).toContain("Status: completed");
		expect(deliveredText).toBe(text);
		expect(deliveredDetails).toEqual({ async: { state: "completed", jobId: "job-1", type: "agnes-video" } });
		// create + status poll
		expect(requestUrls).toHaveLength(2);
		expect(requestUrls[1]).toContain("/agnesapi?video_id=video_1");
	});

	it("waits synchronously when wait: true", async () => {
		const { manager } = createFakeJobManager();
		const requestUrls: string[] = [];
		const fetchMock = createFetchMock(requestUrls);

		const result = await agnesVideoGenTool.execute(
			"c3",
			{ prompt: "a cat walking", wait: true },
			undefined,
			createContext({ manager, fetch: fetchMock }),
			undefined,
		);

		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("URL: https://platform-outputs.example/videos/agnes-video-v2.0/video_1.mp4");
		expect(result.details).toMatchObject({
			videoId: "video_1",
			status: "completed",
			videoUrl: expect.stringContaining(".mp4"),
		});
		expect(result.details?.sizeMapping).toMatchObject({
			adjusted: true,
			resolution: "720p",
			width: 1088,
			height: 832,
		});
		expect(requestUrls).toHaveLength(2);
	});

	it("falls back to synchronous polling without a job manager", async () => {
		const requestUrls: string[] = [];
		const fetchMock = createFetchMock(requestUrls);

		const result = await agnesVideoGenTool.execute(
			"c4",
			{ prompt: "a cat walking" },
			undefined,
			createContext({ manager: undefined, fetch: fetchMock }),
			undefined,
		);

		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("URL: https://platform-outputs.example/videos/agnes-video-v2.0/video_1.mp4");
		expect(requestUrls).toHaveLength(2);
	});

	it("rejects num_frames that violate the 8n+1 rule before submitting", async () => {
		const requestUrls: string[] = [];
		const fetchMock = createFetchMock(requestUrls);
		const { manager } = createFakeJobManager();

		const result = await agnesVideoGenTool.execute(
			"c5",
			{ prompt: "x", num_frames: 120 },
			undefined,
			createContext({ manager, fetch: fetchMock }),
			undefined,
		);

		const text = result.content.find(b => b.type === "text")?.text ?? "";
		expect(text).toContain("8n+1");
		expect(result.details).toMatchObject({ status: "invalid_parameters" });
		expect(requestUrls).toHaveLength(0);
	});

	it("propagates generation failure as a rejected job run", async () => {
		const { manager, jobs } = createFakeJobManager();
		const requestUrls: string[] = [];
		const fetchMock = (async (input: string | URL | Request) => {
			const url = input.toString();
			requestUrls.push(url);
			if (url.includes("/v1/videos")) return jsonResponse(CREATE_RESPONSE);
			if (url.includes("/agnesapi"))
				return jsonResponse({ id: "video_1", status: "failed", error: { message: "content policy" } });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		await agnesVideoGenTool.execute(
			"c6",
			{ prompt: "x" },
			undefined,
			createContext({ manager, fetch: fetchMock }),
			undefined,
		);
		expect(jobs).toHaveLength(1);
		await expect(jobs[0]!.run({ jobId: "job-1", signal: undefined, reportProgress: async () => {} })).rejects.toThrow(
			"content policy",
		);
	});
});
