import { Markdown, t } from "@musepi/desktop-web";
import { Check as CheckIconData, Copy as CopyIconData } from "lucide";
import { Loader } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { DialogFrame } from "./DialogFrame";
import { Icon } from "../vendor/oc-icons";
import { dataUrlToBlob } from "../lib/image-resize";

/**
 * 保存为图片 export dialog: a LIVE preview of the message card with three
 * style options (title / border / watermark) applied WYSIWYG, and a copy
 * button that rasterizes the preview DOM (html-to-image, pixelRatio 2 —
 * same pipeline the old one-shot export used) and pushes the PNG to the
 * clipboard. The copy button morphs Copy → ✓ (morphicons) once the write
 * lands; the transcript row's save button is now just the dialog trigger.
 *
 * The preview card IS the export source, so what you see is what you get —
 * including the watermark, which must sit INSIDE the captured node.
 */
export function SaveImageDialog({
	open,
	onClose,
	text,
}: {
	open: boolean;
	onClose(): void;
	/** Markdown source of the message being exported. */
	text: string;
}): ReactNode {
	const [title, setTitle] = useState("");
	const [border, setBorder] = useState(false);
	const [watermark, setWatermark] = useState(false);
	const [watermarkText, setWatermarkText] = useState("MusePi");
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const cardRef = useRef<HTMLDivElement | null>(null);

	// Fresh transient state every time the dialog opens.
	useEffect(() => {
		if (open) {
			setBusy(false);
			setCopied(false);
		}
	}, [open]);

	const copy = async (): Promise<void> => {
		const card = cardRef.current;
		if (!card || busy) return;
		setBusy(true);
		try {
			const { toPng } = await import("html-to-image");
			const bg = getComputedStyle(card).backgroundColor || "#ffffff";
			const dataUrl = await toPng(card, { quality: 1, pixelRatio: 2, backgroundColor: bg });
			const blob = await (await fetch(dataUrl)).blob();
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard / image API unavailable — keep the idle icon
		} finally {
			setBusy(false);
		}
	};

	return (
		<DialogFrame open={open} onClose={onClose} label={t("save as image")} className="gui-saveimg-dialog">
			<div className="gui-saveimg-head">
				<span className="gui-saveimg-title">{t("save as image")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="gui-saveimg-body">
				<div className="gui-saveimg-preview">
					<div
						ref={cardRef}
						className={`gui-saveimg-card${border ? " gui-saveimg-card--border" : ""}`}
					>
						{title.trim() && <div className="gui-saveimg-card-title">{title.trim()}</div>}
						<div className="gui-saveimg-card-md">
							<Markdown text={text} />
						</div>
						{watermark && watermarkText.trim() && (
							<div className="gui-saveimg-card-wm">{watermarkText.trim()}</div>
						)}
					</div>
				</div>
				<div className="gui-saveimg-options">
					<label className="gui-saveimg-opt">
						<span>{t("title")}</span>
						<input
							type="text"
							className="gui-task-input gui-saveimg-input"
							value={title}
							onChange={e => setTitle(e.target.value)}
							placeholder={t("image title placeholder")}
						/>
					</label>
					<label className="gui-saveimg-opt gui-saveimg-opt--toggle">
						<input type="checkbox" checked={border} onChange={e => setBorder(e.target.checked)} />
						<span>{t("border")}</span>
					</label>
					<label className="gui-saveimg-opt gui-saveimg-opt--toggle">
						<input type="checkbox" checked={watermark} onChange={e => setWatermark(e.target.checked)} />
						<span>{t("watermark")}</span>
					</label>
					<input
						type="text"
						className="gui-task-input gui-saveimg-input"
						value={watermarkText}
						disabled={!watermark}
						onChange={e => setWatermarkText(e.target.value)}
						placeholder={t("image watermark placeholder")}
					/>
					<button
						type="button"
						className="gui-btn gui-btn-primary gui-saveimg-copy"
						onClick={() => void copy()}
						disabled={busy}
						title={t("copy image")}
					>
						{busy ? (
							<Loader size={13} className="gui-spin" />
						) : (
							<MorphIcon icon={copied ? CheckIconData : CopyIconData} size={13} spring="snappy" />
						)}
						<span>{busy ? t("saving image…") : copied ? t("copied") : t("copy image")}</span>
					</button>
				</div>
			</div>
		</DialogFrame>
	);
}
