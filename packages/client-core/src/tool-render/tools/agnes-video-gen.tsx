/**
 * `agnes_video_gen` — generated video from the Agnes video API. The result
 * travels in `details.videoUrl` (kept out of model context, same contract as
 * `generate_image`'s `details.images`), so the body plays it inline instead of
 * dumping the JSON details. Async runs (`wait: false`) return a job handle;
 * the finished video previews on the background-job row instead.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Kv, KvGrid, Note, ResultText, ResultVideo } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, str, truncate } from "../util";

/** `status` plus optional progress — the one compact line both parts show. */
function videoState(details: Record<string, unknown> | null): string | null {
	const status = str(details?.status);
	if (!status) return null;
	const progress = typeof details?.progress === "number" ? `${Math.round(details.progress)}%` : null;
	return progress ? `${status} · ${progress}` : status;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const prompt = str(args.prompt);
	return (
		<>
			{prompt ? <span>{truncate(prompt, 80)}</span> : null} <Badge>{videoState(detailsRecord(result))}</Badge>
		</>
	);
}

function Body({ args, result, running }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const videoUrl = str(details?.videoUrl);
	const prompt = str(args.prompt);
	// `wait: false` submits and returns a handle: nothing to play yet.
	const queued = details?.async !== undefined;
	const state = videoState(details);
	const duration = typeof details?.durationSeconds === "number" ? `${details.durationSeconds}s` : null;
	const size = str(details?.size);
	const requestedSize = str(args.size);
	return (
		<>
			{videoUrl ? (
				<ResultVideo src={videoUrl} title={prompt ?? undefined} />
			) : running || queued ? (
				<Note>{state ? t("tools.videoGeneratingWithState", { state }) : t("tools.videoGenerating")}</Note>
			) : null}
			{prompt ? <div className="tv-prose">{prompt}</div> : null}
			<KvGrid>
				{state ? <Kv k={t("tools.videoStatus")}>{state}</Kv> : null}
				{duration ? <Kv k={t("tools.videoDuration")}>{duration}</Kv> : null}
				{(size ?? requestedSize) ? <Kv k={t("tools.videoSize")}>{size ?? requestedSize}</Kv> : null}
			</KvGrid>
			{videoUrl ? null : <ResultText result={result} />}
		</>
	);
}

export const agnesVideoGenRenderer: ToolRenderer = {
	labelKey: "tools.toolAgnesVideoGen",
	Summary,
	Body,
};
