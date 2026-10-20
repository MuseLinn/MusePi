/**
 * The file pane's media, font and mermaid previews.
 *
 * Split out of `FilePane` for the same reason the viewers were: the pane is
 * already a large component, and these three are self-contained — each owns one
 * browser API (the media element, the font registry, the diagram renderer) and
 * needs nothing from the pane but the file's URL and name.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type MermaidMode, renderMermaidHtml, t } from "@musepi/client-core";

/** Audio and video, played by the browser's own media element.
 *
 * A codec the runtime cannot decode surfaces as the element's error event;
 * the preview says so instead of showing a dead player. */
export function MediaPreview({
	kind,
	url,
	name,
}: {
	kind: "audio" | "video";
	url: string;
	name: string;
}): ReactNode {
	const [failed, setFailed] = useState(false);
	const [duration, setDuration] = useState<number | null>(null);
	const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

	useEffect(() => {
		setFailed(false);
		setDuration(null);
		setDimensions(null);
	}, [url]);

	const onLoadedMetadata = (event: React.SyntheticEvent<HTMLMediaElement>) => {
		const media = event.currentTarget;
		setDuration(Number.isFinite(media.duration) ? media.duration : null);
		if (media instanceof HTMLVideoElement) setDimensions({ width: media.videoWidth, height: media.videoHeight });
	};

	return (
		<div className="gui-filepane-preview-media">
			{failed ? (
				<div className="gui-filepane-preview-media-fail">
					<p className="gui-filepane-preview-note">{t("settings.previewMediaUnplayable")}</p>
					<p className="gui-filepane-preview-note">{name}</p>
				</div>
			) : kind === "video" ? (
				<div className="gui-filepane-preview-media-video">
					<video
						key={url}
						src={url}
						controls
						playsInline
						preload="metadata"
						title={name}
						onLoadedMetadata={onLoadedMetadata}
						onError={() => setFailed(true)}
					/>
				</div>
			) : (
				<div className="gui-filepane-preview-media-audio">
					<p className="gui-filepane-preview-media-name">{name}</p>
					<audio
						key={url}
						src={url}
						controls
						preload="metadata"
						title={name}
						onLoadedMetadata={onLoadedMetadata}
						onError={() => setFailed(true)}
					/>
				</div>
			)}
			{!failed && (duration !== null || dimensions !== null) && (
				<p className="gui-filepane-preview-note">
					{duration !== null && formatDuration(duration)}
					{duration !== null && dimensions !== null && " · "}
					{dimensions !== null && `${dimensions.width} × ${dimensions.height}`}
				</p>
			)}
		</div>
	);
}

/** `m:ss`, or `h:mm:ss` past the hour. */
function formatDuration(seconds: number): string {
	const whole = Math.round(seconds);
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const rest = whole % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

const SAMPLE_SIZES = [48, 32, 24, 18, 14] as const;
const GLYPH_ROWS = [
	"ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	"abcdefghijklmnopqrstuvwxyz",
	"0123456789 .,;:!?&@#%()[]{}<>+-=/\\*\"'",
] as const;

let fontFamilyCounter = 0;

/** A type specimen: the font registered under a throwaway family name for as
 *  long as the preview is open, so nothing else in the app can pick it up. */
export function FontPreview({ url, name }: { url: string; name: string }): ReactNode {
	const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
	const [family] = useState(() => {
		fontFamilyCounter += 1;
		return `musepi-font-preview-${fontFamilyCounter}`;
	});

	useEffect(() => {
		let cancelled = false;
		setStatus("loading");
		const face = new FontFace(family, `url("${url.replace(/"/g, "%22")}")`);
		document.fonts.add(face);
		face
			.load()
			.then(() => {
				if (!cancelled) setStatus("ready");
			})
			.catch(() => {
				if (!cancelled) setStatus("failed");
			});
		return () => {
			cancelled = true;
			document.fonts.delete(face);
		};
	}, [family, url]);

	if (status === "failed") {
		return <p className="gui-filepane-preview-note">{t("settings.previewFontLoadFailed")}</p>;
	}
	if (status === "loading") {
		return <p className="gui-filepane-preview-note">{t("settings.loading2")}</p>;
	}
	return (
		<div className="gui-filepane-preview-font" style={{ fontFamily: `"${family}"` }}>
			<p className="gui-filepane-preview-note">{name}</p>
			{SAMPLE_SIZES.map(size => (
				<div key={size} className="gui-filepane-preview-font-row">
					<span className="gui-filepane-preview-font-size">{size}</span>
					<span className="gui-filepane-preview-font-sample" style={{ fontSize: `${size}px` }}>
						{t("settings.previewFontSample")}
					</span>
				</div>
			))}
			<div className="gui-filepane-preview-font-glyphs">
				{GLYPH_ROWS.map(row => (
					<div key={row} className="gui-filepane-preview-font-glyphrow">
						{row}
					</div>
				))}
			</div>
		</div>
	);
}

/** A Mermaid diagram file, rendered by the transcript's diagram renderer. */
export function MermaidPreview({ source }: { source: string }): ReactNode {
	const html = renderMermaidHtml(source, "svg" as MermaidMode);
	return <div className="gui-filepane-preview-mermaid" dangerouslySetInnerHTML={{ __html: html }} />;
}
