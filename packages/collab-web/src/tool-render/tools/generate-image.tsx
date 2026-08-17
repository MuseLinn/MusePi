/**
 * `generate_image` — structured image-generation prompt plus the produced
 * image(s). Generated images travel in `details.images` (kept out of model
 * context), so the body merges them into the result before thumbnailing.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, Badges, InvalidArg, Kv, KvGrid, Note, PathText, ResultImages, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps, ToolResultBlock, ToolResultLike } from "../types";
import { detailsRecord, isRecord, normalizeWs, resultImagesOf, str, truncate } from "../util";

/** Result with `details.images` (`{data, mimeType}[]`) appended as image blocks. */
function withDetailImages(result: ToolResultLike | undefined): ToolResultLike | undefined {
	const details = detailsRecord(result);
	if (!result || !details || !Array.isArray(details.images)) return result;
	const extra: ToolResultBlock[] = [];
	for (const img of details.images) {
		if (isRecord(img) && typeof img.data === "string" && typeof img.mimeType === "string") {
			extra.push({ type: "image", data: img.data, mimeType: img.mimeType });
		}
	}
	if (extra.length === 0) return result;
	return { content: [...result.content, ...extra], details: result.details, isError: result.isError };
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const subject = str(args.subject);
	const aspect = str(args.aspect_ratio);
	const changes = Array.isArray(args.changes) ? args.changes.length : 0;
	return (
		<>
			{subject ? (
				<span>{truncate(normalizeWs(subject), 80)}</span>
			) : (
				args.subject !== undefined && <InvalidArg what="subject" />
			)}{" "}
			{aspect && <Badge>{aspect}</Badge>}
			{changes > 0 && <Badge tone="accent">{t("edit ×{count}", { count: String(changes) })}</Badge>}
		</>
	);
}

const PROMPT_FIELDS = [
	["subject", "subject"],
	["action", "action"],
	["scene", "scene"],
	["composition", "composition"],
	["lighting", "lighting"],
	["style", "style"],
	["text", "text"],
	["aspect_ratio", "aspect"],
	["image_size", "size"],
] as const;

function Body({ args, result, running }: ToolRenderProps): ReactNode {
	const changes = Array.isArray(args.changes) ? args.changes : null;
	const inputs = Array.isArray(args.input) ? args.input : null;
	const details = detailsRecord(result);
	const provider = str(details?.provider);
	const model = str(details?.model);
	const revised = str(details?.revisedPrompt);
	const paths: string[] = [];
	if (details && Array.isArray(details.imagePaths)) {
		for (const p of details.imagePaths) {
			if (typeof p === "string") paths.push(p);
		}
	}
	const merged = withDetailImages(result);
	const hasImages = resultImagesOf(merged).length > 0;
	// aicss image-generation: the prompt rides as a caption under the preview.
	const caption = str(args.subject) ?? str(details?.revisedPrompt) ?? null;
	const subjectPrompt = str(args.prompt) ?? str(args.subject) ?? null;
	// aicss image-generation: while the tool runs, show a shimmering canvas
	// placeholder (prompt riding inside) instead of the args table.
	const placeholder =
		running && !hasImages ? (
			<div
				className="tr-img-placeholder"
				style={{ aspectRatio: (str(args.aspect_ratio) ?? "1:1").replace(":", "/") }}
			>
				<div className="tr-img-shimmer" aria-hidden="true" />
				<div className="tr-img-ph-title">{t("generating image")}</div>
				{subjectPrompt && (
					<div className="tr-img-ph-prompt">“{subjectPrompt.length > 140 ? `${subjectPrompt.slice(0, 140)}…` : subjectPrompt}”</div>
				)}
			</div>
		) : null;
	return (
		<>
			{placeholder ?? (
				<>
			<KvGrid>
				{PROMPT_FIELDS.map(([arg, label]) => {
					const value = args[arg];
					return (
						<Kv key={arg} k={t(label)}>
							{value === undefined ? null : (str(value) ?? <InvalidArg what={label} />)}
						</Kv>
					);
				})}
			</KvGrid>
			{changes && changes.length > 0 && (
				<div className="tv-list">
					{changes.map((change, i) => (
						// Tool-argument rows are static arrays — the index is their identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: static arg rows
						<Row key={i} k={i === 0 ? t("changes") : undefined}>
							{typeof change === "string" ? change : <InvalidArg what="change" />}
						</Row>
					))}
				</div>
			)}
			{inputs && inputs.length > 0 && (
				<div className="tv-list">
					{inputs.map((input, i) => {
						const path = isRecord(input) ? str(input.path) : null;
						const mime = isRecord(input) ? str(input.mime_type) : null;
						return (
							// Tool-argument rows are static arrays — the index is their identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: static arg rows
							<Row key={i} k={i === 0 ? t("input") : undefined}>
								{!isRecord(input) ? (
									<InvalidArg what="input" />
								) : path ? (
									<PathText path={path} />
								) : mime ? (
									t("base64 image ({mime})", { mime: mime })
								) : (
									t("base64 image")
								)}
							</Row>
						);
					})}
				</div>
			)}
			{(provider || model) && <Badges items={[provider, model]} />}
			{revised && <Note>{t("revised: {value}", { value: truncate(revised, 400) })}</Note>}
			{hasImages && (
				<figure className="tr-tool-image">
					<ResultImages result={merged} />
					{caption && <figcaption className="tr-tool-image-caption">{caption}</figcaption>}
				</figure>
			)}
			{paths.length > 0 && (
				<div className="tv-list">
					{paths.map((p, i) => (
						// Tool-argument rows are static arrays — the index is their identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: static arg rows
						<Row key={i} k={i === 0 ? t("saved") : undefined}>
							<PathText path={p} />
						</Row>
					))}
				</div>
			)}
			{!hasImages && <ResultText result={result} maxLines={8} />}
			</>
			)}
		</>
	);
}

export const generateImageRenderer: ToolRenderer = { Summary, Body };
