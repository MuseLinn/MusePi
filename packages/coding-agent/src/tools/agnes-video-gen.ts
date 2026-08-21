import { type } from "@musepi/musepi-type";
import { type ApiKey, type FetchImpl, getEnvApiKey, withAuth } from "@musepi/pi-ai";
import { prompt, untilAborted } from "@musepi/pi-utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import agnesVideoGenDescription from "../prompts/tools/agnes-video-gen.md" with { type: "text" };

// Mainland China endpoint — https://www.agnes-ai.cn; international endpoint —
// https://agnes-ai.com. Mirrors the agnes / agnes-global catalog base URLs in
// `@musepi/pi-catalog` provider-models; the active session model decides which
// one is used.
const AGNES_BASE_URL_CN = "https://api.agnes-ai.cn/v1";
const AGNES_BASE_URL_GLOBAL = "https://apihub.agnes-ai.com/v1";
const DEFAULT_VIDEO_MODEL = "agnes-video-v2.0";
const POLL_INTERVAL_MS = 3_000;
// Longer videos (up to 441 frames) plus the 65s 429 backoff can easily exceed
// 3 minutes wall-clock — verified against the live API (2026-08): a short 81-frame
// job took 143-189s including one 429 wait. 10 minutes covers backoff + long jobs.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const videoSchema = type({
	prompt: type("string").describe("Text description of the video content"),
	"image?": type("string").describe("Image URL for image-to-video workflows"),
	"mode?": type.enumerated("ti2vid", "keyframes").describe("Generation mode"),
	"height?": type("number").describe("Video height (default 768)"),
	"width?": type("number").describe("Video width (default 1152)"),
	"num_frames?": type("number.integer <= 441").describe("Number of frames (<= 441, 8n+1)"),
	"frame_rate?": type("number >= 1").and("number <= 60").describe("Frame rate (1-60)"),
	"negative_prompt?": type("string").describe("Negative prompt describing content to avoid"),
	"seed?": type("number").describe("Random seed for reproducible results"),
	"num_inference_steps?": type("number").describe("Number of inference steps"),
	"keyframes?": type("string[]").describe("Keyframe image URLs for keyframe animation (extra_body.image)"),
	"wait?": type("boolean").describe(
		"Wait for generation to finish before returning (default false: submit and return immediately, delivering the result as a background job when the URL is ready)",
	),
});

interface AgnesVideoAsyncDetails {
	readonly state: "running";
	readonly jobId: string;
	readonly type: "agnes-video";
}

interface AgnesVideoToolDetails {
	readonly taskId: string;
	readonly videoId: string;
	readonly status: string;
	readonly progress?: number;
	readonly videoUrl?: string;
	readonly durationSeconds?: number;
	readonly size?: string;
	readonly sizeMapping?: AgnesVideoStatus["size_mapping"];
	readonly async?: AgnesVideoAsyncDetails;
}

interface AgnesVideoStatus {
	id?: string;
	task_id?: string;
	video_id?: string;
	status?: string;
	progress?: number;
	seconds?: string | number;
	size?: string;
	url?: string;
	error?: string | { message?: string };
	size_mapping?: {
		adjusted?: boolean;
		resolution?: string;
		ratio?: string;
		requested_width?: number;
		requested_height?: number;
		width?: number;
		height?: number;
		message?: string;
	};
	metadata?: { url?: string; seconds?: string | number; size?: string };
}

async function pollVideoStatus(
	apiKey: ApiKey,
	videoId: string,
	baseUrl: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<AgnesVideoToolDetails> {
	const startTime = Date.now();

	while (true) {
		if (signal?.aborted) {
			throw new Error("Video generation aborted");
		}

		const elapsed = Date.now() - startTime;
		if (elapsed > POLL_TIMEOUT_MS) {
			throw new Error(`Video generation timed out after ${POLL_TIMEOUT_MS / 1000}s`);
		}

		// 429 (rate limit) returns a retry sentinel instead of continuing inside
		// the withAuth callback — `continue` cannot cross a function boundary.
		// The outer loop re-polls after the wait.
		const statusText = await withAuth<string | null>(
			apiKey,
			async key => {
				const statusBase = baseUrl.replace(/\/v1\/?$/, "");
				const url = new URL(`${statusBase}/agnesapi`);
				url.searchParams.set("video_id", videoId);
				const resp = await fetchImpl(url.toString(), {
					headers: { Authorization: `Bearer ${key}` },
					signal,
				});
				if (resp.status === 429) {
					const { promise: retryDelay, resolve: resolveRetryDelay } = Promise.withResolvers<void>();
					setTimeout(resolveRetryDelay, 65_000);
					await retryDelay;
					return null;
				}
				if (!resp.ok) {
					throw new Error(`Agnes video status failed (${resp.status})`);
				}
				return resp.text();
			},
			{ signal },
		);
		if (statusText === null) continue;

		let statusData: AgnesVideoStatus;
		try {
			statusData = JSON.parse(statusText);
		} catch {
			throw new Error("Invalid Agnes video status response");
		}

		const status = typeof statusData.status === "string" ? statusData.status : "unknown";
		const taskId =
			typeof statusData.task_id === "string"
				? statusData.task_id
				: typeof statusData.id === "string"
					? statusData.id
					: "";

		// Verified against the live API (2026-08): the final video URL lives in the
		// TOP-LEVEL `url` field of the status response; `metadata` is null and
		// `metadata.url` never exists (docs are wrong). Keep the metadata read as a
		// defensive fallback only.
		const videoUrl =
			typeof statusData.url === "string" && statusData.url.length > 0 ? statusData.url : statusData.metadata?.url;

		if (status === "succeeded" || status === "completed" || videoUrl) {
			const metadata = statusData.metadata ?? {};
			return {
				taskId,
				videoId,
				status,
				progress: typeof statusData.progress === "number" ? statusData.progress : undefined,
				videoUrl,
				durationSeconds:
					typeof metadata.seconds === "string"
						? Number.parseFloat(metadata.seconds)
						: typeof statusData.seconds === "string"
							? Number.parseFloat(statusData.seconds)
							: undefined,
				size: metadata.size ?? statusData.size,
				sizeMapping: statusData.size_mapping,
			};
		}

		if (status === "failed" || status === "cancelled") {
			const errorMessage =
				typeof statusData.error === "string"
					? statusData.error
					: typeof statusData.error?.message === "string"
						? statusData.error.message
						: "unknown error";
			throw new Error(`Agnes video generation ${status}: ${errorMessage}`);
		}

		const { promise: delayPromise, resolve: resolveDelay } = Promise.withResolvers<void>();
		setTimeout(resolveDelay, POLL_INTERVAL_MS);
		await delayPromise;
	}
}

function formatVideoResult(result: AgnesVideoToolDetails): string {
	const lines = [
		`Task: ${result.taskId}`,
		`Video: ${result.videoId}`,
		`Status: ${result.status}`,
		...(result.progress !== undefined ? [`Progress: ${result.progress}%`] : []),
		...(result.size ? [`Size: ${result.size}`] : []),
		...(result.durationSeconds ? [`Duration: ${result.durationSeconds}s`] : []),
		...(result.videoUrl ? [`URL: ${result.videoUrl}`] : ["Video URL not yet available"]),
	];
	return lines.join("\n");
}

export const agnesVideoGenTool: CustomTool<typeof videoSchema, AgnesVideoToolDetails> = {
	name: "agnes_video_gen",
	label: "AgnesVideoGen",
	strict: false,
	approval: "write",
	description: prompt.render(agnesVideoGenDescription),
	parameters: videoSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			// Docs: num_frames must satisfy 8n+1 (schema already enforces integer <= 441).
			if (params.num_frames !== undefined && (params.num_frames - 1) % 8 !== 0) {
				return {
					content: [
						{
							type: "text",
							text: `num_frames must satisfy the 8n+1 rule (e.g. 81, 121, 241, 441); got ${params.num_frames}.`,
						},
					],
					details: { taskId: "", videoId: "", status: "invalid_parameters" },
				};
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const fetchImpl = ctx.fetch ?? fetch;
			// Route by the active chat model's provider: agnes-global sessions hit
			// the international endpoint, everything else stays on the mainland CN
			// endpoint.
			const isGlobal = ctx.model?.provider === "agnes-global";
			const provider: "agnes" | "agnes-global" = isGlobal ? "agnes-global" : "agnes";
			const baseUrl = isGlobal ? AGNES_BASE_URL_GLOBAL : AGNES_BASE_URL_CN;

			// Auth storage (/login) first, env fallback — same dual channel as the
			// image_gen agnes branch.
			const apiKey = (await ctx.modelRegistry.getApiKeyForProvider(provider, sessionId)) ?? getEnvApiKey(provider);
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "No Agnes API key configured. Set AGNES_API_KEY (mainland China) or AGNES_GLOBAL_API_KEY (international).",
						},
					],
					details: { taskId: "", videoId: "", status: "missing_credentials" },
				};
			}

			const body: Record<string, unknown> = {
				model: DEFAULT_VIDEO_MODEL,
				prompt: params.prompt,
				...(params.image && { image: params.image }),
				...(params.mode && { mode: params.mode }),
				...(params.height && { height: params.height }),
				...(params.width && { width: params.width }),
				...(params.num_frames && { num_frames: params.num_frames }),
				...(params.frame_rate !== undefined && { frame_rate: params.frame_rate }),
				...(params.negative_prompt && { negative_prompt: params.negative_prompt }),
				...(params.seed !== undefined && { seed: params.seed }),
				...(params.num_inference_steps !== undefined && {
					num_inference_steps: params.num_inference_steps,
				}),
			};
			// Keyframe animation per docs: input frames go in extra_body.image with
			// extra_body.mode: "keyframes" (takes precedence over any top-level mode).
			if (params.keyframes?.length) {
				body.extra_body = {
					image: params.keyframes,
					mode: "keyframes",
				};
			}

			const createText = await withAuth(
				apiKey,
				async key => {
					const resp = await fetchImpl(`${baseUrl}/videos`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${key}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
						signal,
					});
					if (!resp.ok) {
						const text = await resp.text();
						throw new Error(`Agnes video create failed (${resp.status}): ${text}`);
					}
					return resp.text();
				},
				{ signal },
			);

			const createData = JSON.parse(createText);
			const videoId =
				typeof createData.video_id === "string"
					? createData.video_id
					: typeof createData.id === "string"
						? createData.id
						: "";
			if (!videoId) {
				throw new Error("Agnes video creation did not return a video_id");
			}
			const taskId =
				typeof createData.task_id === "string"
					? createData.task_id
					: typeof createData.id === "string"
						? createData.id
						: "";

			const manager = ctx.asyncJobManager;
			// Synchronous path: explicit wait, or no background job manager available
			// (restricted/headless SDK sessions) — fall back to inline polling.
			if (params.wait === true || !manager) {
				const result = await pollVideoStatus(apiKey, videoId, baseUrl, signal, fetchImpl);
				return {
					content: [{ type: "text", text: formatVideoResult(result) }],
					details: result,
				};
			}

			// Background path (default): submit, register a job that polls to
			// completion, and return immediately. The job's completion text routes
			// back through the session's async-result channel, so the agent can
			// continue working instead of blocking for minutes. Cancelling the job
			// aborts the poll via its run signal.
			const label = params.prompt.slice(0, 96) + (params.prompt.length > 96 ? "…" : "");
			const jobId = manager.register(
				"agnes-video",
				label,
				async ({ jobId: runJobId, signal: runSignal, reportProgress }) => {
					const result = await pollVideoStatus(apiKey, videoId, baseUrl, runSignal, fetchImpl);
					const text = formatVideoResult(result);
					await reportProgress(text, { async: { state: "completed", jobId: runJobId, type: "agnes-video" } });
					return text;
				},
				{ ownerId: ctx.agentId },
			);

			return {
				content: [
					{
						type: "text",
						text: `Video generation submitted (task ${taskId || videoId}); backgrounded as job ${jobId}; result will be delivered automatically.`,
					},
				],
				details: {
					taskId,
					videoId,
					status: "queued",
					async: { state: "running", jobId, type: "agnes-video" },
				},
			};
		});
	},
};
