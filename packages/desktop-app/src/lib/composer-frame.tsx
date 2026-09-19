import { ImageLightbox, t } from "@musepi/guest-client";
import { type ReactNode, useState } from "react";
import { BorderBeam } from "../vendor/border-beam";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * Shared composer container (welcome + in-session parity): one frame shell
 * renders the textarea, the attachment chips and the footer row for BOTH
 * scenes, so the welcome→session transition can morph one container into
 * the other (FLIP in ChatView) instead of cross-fading two different trees.
 *
 * `flipAnchor` marks the frame for the morph measurement; the incoming
 * frame animates from the outgoing frame's rect via gui-flip-morph.
 */
/** Icon name for a file chip by extension (icon-set parity: the same
 *  mapping the workspace tree uses for its entries). */
function fileIconFor(name: string): IconName {
	const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
	if (ext === "pdf") return "file-pdf";
	if (["md", "txt", "rtf", "doc", "docx", "pages"].includes(ext)) return "file-text";
	if (
		[
			"js",
			"ts",
			"tsx",
			"jsx",
			"py",
			"go",
			"rs",
			"java",
			"c",
			"h",
			"cpp",
			"cs",
			"rb",
			"php",
			"sh",
			"bat",
			"ps1",
			"json",
			"yaml",
			"yml",
			"toml",
			"xml",
			"html",
			"css",
			"sql",
		].includes(ext)
	)
		return "file-code";
	if (["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(ext)) return "file-music";
	if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "file-video";
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic"].includes(ext)) return "file-image";
	return "file";
}

/** "1.2 MB"-style size label (openchamber parity). */
function attachSizeLabel(bytes: number | undefined): string {
	if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ComposerFrame({
	className = "",
	children,
	attachments,
	onRemoveAttachment,
	onEditSketch,
	onEditImage,
	onAddAttachment,
	onAnnotated,
	aboveRow,
	footerLeft,
	footerRight,
	hero = false,
	heroActive = false,
	enhancing = false,
	flipAnchor,
	pet = null,
	chatInput = false,
}: {
	className?: string;
	/** Textarea + any floating menus the composer needs (absolute). */
	children: ReactNode;
	attachments: {
		id: number;
		kind?: "image" | "file";
		dataUrl: string;
		mimeType: string;
		name: string;
		size?: number;
		/** Send-time upload in flight → progress ring overlay (file chips). */
		uploading?: boolean;
		/** Board-drawn chip: click reopens the sketch canvas for editing. */
		sketch?: boolean;
	}[];
	onRemoveAttachment(id: number): void;
	/** Board-drawn chip clicked: reopen the sketch board for editing (Codex
	 *  parity — clicking the drawn image falls back into the canvas).
	 *
	 *  Deliberately NOT optional: making it optional let a host that renders
	 *  chips omit it, and the click then silently degraded to the plain image
	 *  lightbox with nothing failing loudly. The marker was in fact being
	 *  dropped upstream, but "no handler" is the failure mode this signature
	 *  now makes unrepresentable. Hosts that render chips must wire it. */
	onEditSketch(id: number): void;
	/** Edit an image in the sketch board from the attachment lightbox
	 *  (Codex 编辑预览 parity). Receives the image source. */
	onEditImage?(src: string): void;
	/** Render the trailing "+" card in the attachment row (opens the
	 *  all-types picker). Omitted on scenes without attachment intake. */
	onAddAttachment?(): void;
	/** Annotation text from the attachment lightbox (open-science parity):
	 *  pins + notes formatted for the composer/agent. */
	onAnnotated?(text: string): void;
	/** Row(s) hanging ABOVE the input card, outside the framed surface —
	 *  todo/queue chips and the agent status line live here so the input
	 *  box itself stays clean (user direction: status belongs above the
	 *  input, not inside it). */
	aboveRow?: ReactNode;
	footerLeft: ReactNode;
	footerRight: ReactNode;
	/** Border-beam hero glow (welcome scene). */
	hero?: boolean;
	/** Drive the beam's active state — focus-triggered: the beam fades in
	 *  while the composer has focus and fades out on blur (never a static
	 *  box). Only meaningful with hero. */
	heroActive?: boolean;
	/** data-enhancing marker (session). */
	enhancing?: boolean;
	flipAnchor?: "welcome" | "session";
	/** Companion pet, docked outside the input's top edge, right-aligned
	 *  (input mode). Rendered absolutely against the frame so welcome and
	 *  session scenes share one placement. */
	pet?: ReactNode;
	/** Mark the frame as the chat-input host ([data-chat-input="true"],
	 *  openchamber parity) so global selection capture never re-quotes
	 *  what is being typed. */
	chatInput?: boolean;
}): ReactNode {
	// Click-to-preview lightbox for image attachment thumbnails (before
	// send); the gallery covers image chips only — file chips are inert
	// icon cards with nothing to zoom.
	const [preview, setPreview] = useState<{ items: { src: string; alt: string }[]; index: number } | null>(null);
	const imageChips = attachments.filter(a => a.kind !== "file" && a.dataUrl);
	const openPreview = (chipId: number) =>
		setPreview({
			items: imageChips.map(x => ({ src: x.dataUrl, alt: x.name })),
			index: imageChips.findIndex(x => x.id === chipId),
		});
	const frame = (
		<div
			className={`${className} gui-composer-frame`}
			data-enhancing={enhancing || undefined}
			data-chat-input={chatInput ? "true" : undefined}
			// data-flip-anchor rides on the hero wrapper (BorderBeam) when
			// present — the morph must transform the element that carries
			// the shadow + beam, not the frame inside it.
			data-flip-anchor={flipAnchor && !hero ? flipAnchor : undefined}
		>
			{pet && <div className="gui-composer-pet">{pet}</div>}
			{children}
			{/* The attach row exists to hold chips. With no attachments it used
			 * to still render — and with `onAddAttachment` always wired by the
			 * session composer, that meant a permanent empty 72×72 dashed box
			 * floating in the input (redundant: the attach menu in the footer
			 * already owns "+ add"). Show the row only when it has chips, and
			 * the trailing "+" only once there are chips to append to. */}
			{attachments.length > 0 && (
				<div className="gui-attach-row px-4 pb-2">
					{attachments.map(a =>
						a.kind === "file" ? (
							// File card: extension icon + truncated name (screenshot
							// parity), X top-right, progress ring while the send-time
							// fs.write upload is in flight.
							<div
								key={a.id}
								className={`gui-attach-chip gui-attach-chip--file${a.uploading ? " gui-attach-chip--uploading" : ""}`}
								title={`${a.name}${attachSizeLabel(a.size) ? ` · ${attachSizeLabel(a.size)}` : ""}`}
							>
								<span className="gui-attach-file-icon">
									<Icon name={fileIconFor(a.name)} className="h-5 w-5" />
								</span>
								<span className="gui-attach-file-name">{a.name}</span>
								{a.uploading && <span className="gui-attach-ring" aria-hidden />}
								<button
									type="button"
									className="gui-attach-x"
									aria-label={t("remove attachment")}
									onClick={() => onRemoveAttachment(a.id)}
								>
									<Icon name="close" className="h-3 w-3" />
								</button>
							</div>
						) : (
							<div key={a.id} className={`gui-attach-chip${a.sketch ? " gui-attach-chip--sketch" : ""}`}>
								<img
									src={a.dataUrl}
									alt={a.name}
									className="gui-attach-thumb"
									role="button"
									tabIndex={0}
									title={a.sketch ? t("sketch") : t("preview image")}
									onClick={() => (a.sketch ? onEditSketch(a.id) : openPreview(a.id))}
									onKeyDown={e => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											if (a.sketch) onEditSketch(a.id);
											else openPreview(a.id);
										}
									}}
								/>
								<button
									type="button"
									className="gui-attach-x"
									aria-label={t("remove attachment")}
									onClick={() => onRemoveAttachment(a.id)}
								>
									<Icon name="close" className="h-3 w-3" />
								</button>
							</div>
						),
					)}
					{onAddAttachment && (
						<button
							type="button"
							className="gui-attach-add"
							aria-label={t("add attachments")}
							title={t("add attachments")}
							onClick={onAddAttachment}
						>
							<Icon name="add" className="h-5 w-5" />
						</button>
					)}
				</div>
			)}
			<div className="gui-composer-row px-4 pb-3">
				<div className="gui-composer-left">{footerLeft}</div>
				<div className="gui-composer-right">{footerRight}</div>
			</div>
		</div>
	);
	const lightbox = (
		<ImageLightbox
			items={preview?.items ?? []}
			index={preview?.index ?? null}
			onClose={() => setPreview(null)}
			onIndexChange={i => setPreview(prev => (prev ? { ...prev, index: i } : prev))}
			onEdit={
				onEditImage
					? src => {
							setPreview(null);
							onEditImage(src);
						}
					: undefined
			}
			onAnnotate={notes => {
				const text = notes
					.map(n => `标注 #${n.index}(${n.x.toFixed(1)}%, ${n.y.toFixed(1)}%): ${n.note || "（无说明）"}`)
					.join("\n");
				onAnnotated?.(text);
			}}
		/>
	);
	if (hero)
		return (
			<>
				{aboveRow}
				<BorderBeam
					className={`gui-border-beam${pet ? " gui-border-beam--pet" : ""}`}
					// The scene-switch FLIP morph transforms this wrapper (not
					// the frame): the shadow and beam stroke live on the wrapper,
					// so the whole card — card, shadow, beam — morphs together.
					data-flip-anchor={flipAnchor}
					size="md"
					colorVariant="ocean"
					theme="auto"
					// Same radius as the frame (14px): the beam stroke, the
					// wrapper-carried shadow and the input card all share one
					// corner so nothing looks misaligned.
					borderRadius={14}
					active={heroActive}
				>
					{frame}
				</BorderBeam>
				{lightbox}
			</>
		);
	return (
		<>
			{aboveRow}
			{frame}
			{lightbox}
		</>
	);
}
