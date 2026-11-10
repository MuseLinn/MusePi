/**
 * User-message file cards for stored non-image attachments.
 *
 * The prompt carries these as `[Attachment] blob://<hash> (name)` lines; the
 * transcript strips them from the body (`parseAttachmentRefs`) and renders a
 * card per referenced blob in the same row, with the artifact cards' visual
 * language. Size and text preview come from the optional host capability
 * (`attachment.stat` / `attachment.get`); a host without it keeps the card
 * but hides the size and the preview action.
 */

import { formatBytes } from "@musepi/pi-utils/format";
import type { AttachmentGetResult, AttachmentStatResult } from "@musepi/pi-wire";
import { X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/index.js";
import { useModalFocus } from "../../lib/modal-focus";
import type { ToolRenderHost } from "../../tool-render/types";
import { extBadge } from "./FileCards";
import type { AttachmentRef } from "./user-attachments";
import "./user-attachment-cards.css";

type AttachmentHost = NonNullable<ToolRenderHost["attachment"]>;

/** One request page stays at the daemon's own 8 MiB ceiling. */
const PAGE_BYTES = 8 * 1024 * 1024;

function decodePage(content: string): Uint8Array {
	const raw = atob(content);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

type PreviewState =
	| { phase: "loading" }
	| {
			phase: "text";
			text: string;
			loaded: number;
			size: number;
			done: boolean;
			loading: boolean;
			failed: boolean;
	  }
	| { phase: "binary" }
	| { phase: "error" };

/** Text preview overlay: pages the blob in, decodes as UTF-8 as it goes, and
 *  reports binary content (NUL bytes or invalid UTF-8) instead of forcing it
 *  through the decoder. */
function AttachmentPreview({
	item,
	host,
	onClose,
}: {
	item: AttachmentRef;
	host: AttachmentHost;
	onClose(): void;
}): ReactNode {
	const read = host.read;
	const dialogRef = useModalFocus<HTMLDivElement>(true, { initialFocus: "container" });
	const [state, setState] = useState<PreviewState>({ phase: "loading" });
	// Page state lives in refs: a running TextDecoder must keep its partial
	// sequence across renders, and appended pages read what earlier ones left.
	const decoderRef = useRef<TextDecoder | null>(null);
	const textRef = useRef("");
	const busyRef = useRef(false);
	const aliveRef = useRef(true);
	useEffect(() => {
		// Re-armed on setup so a StrictMode remount does not leave the flag off.
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	const load = useCallback(
		async (offset: number): Promise<void> => {
			if (!read || busyRef.current) return;
			busyRef.current = true;
			if (offset === 0) {
				textRef.current = "";
				decoderRef.current = new TextDecoder("utf-8", { fatal: true });
			}
			setState(prev => (prev.phase === "text" ? { ...prev, loading: true, failed: false } : { phase: "loading" }));
			try {
				const page: AttachmentGetResult | { error: string } = await read(item.hash, offset, PAGE_BYTES);
				if (!aliveRef.current) return;
				if ("error" in page) {
					setState({ phase: "error" });
					return;
				}
				const bytes = decodePage(page.content);
				if (bytes.includes(0)) {
					setState({ phase: "binary" });
					return;
				}
				const next = page.offset + bytes.length;
				// A page that advances nothing would page forever.
				if (bytes.length === 0 && next < page.size) {
					setState({ phase: "error" });
					return;
				}
				const done = next >= page.size;
				const decoder = decoderRef.current ?? new TextDecoder("utf-8", { fatal: true });
				let chunk: string;
				try {
					chunk = decoder.decode(bytes, { stream: !done });
					if (done) chunk += decoder.decode();
				} catch {
					// Invalid UTF-8 — same treatment as NUL bytes.
					setState({ phase: "binary" });
					return;
				}
				textRef.current += chunk;
				setState({
					phase: "text",
					text: textRef.current,
					loaded: next,
					size: page.size,
					done,
					loading: false,
					failed: false,
				});
			} catch {
				if (!aliveRef.current) return;
				setState(prev => (prev.phase === "text" ? { ...prev, loading: false, failed: true } : { phase: "error" }));
			} finally {
				busyRef.current = false;
			}
		},
		[item.hash, read],
	);

	useEffect(() => {
		void load(0);
	}, [load]);

	const body = ((): ReactNode => {
		switch (state.phase) {
			case "loading":
				return <div className="tr-attach-preview-empty">{t("settings.loading")}</div>;
			case "error":
				return <div className="tr-attach-preview-empty">{t("tools.attachmentPreviewFailed")}</div>;
			case "binary":
				return (
					<div className="tr-attach-preview-empty">
						<span>{t("tools.attachmentPreviewUnavailable")}</span>
						{host.save && (
							<button
								type="button"
								className="tr-attach-preview-action"
								onClick={() => host.save?.(item.hash, item.name)}
							>
								{t("tools.attachmentSave")}
							</button>
						)}
					</div>
				);
			case "text":
				return (
					<>
						<pre className="tr-attach-preview-text">{state.text}</pre>
						{(!state.done || state.failed) && (
							<div className="tr-attach-preview-foot">
								<span className="tr-attach-preview-progress">
									{formatBytes(state.loaded)} / {formatBytes(state.size)}
								</span>
								{state.failed && (
									<span className="tr-attach-preview-error" role="alert">
										{t("tools.attachmentPreviewFailed")}
									</span>
								)}
								{!state.done && (
									<button
										type="button"
										className="tr-attach-preview-action"
										disabled={state.loading}
										onClick={() => void load(state.loaded)}
									>
										{state.loading ? t("settings.loading") : t("tools.attachmentLoadMore")}
									</button>
								)}
							</div>
						)}
					</>
				);
		}
	})();

	return createPortal(
		<div
			className="tr-attach-preview"
			role="dialog"
			aria-modal="true"
			aria-label={t("tools.attachmentPreviewTitle")}
			ref={dialogRef}
			tabIndex={-1}
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.stopPropagation();
					onClose();
				}
			}}
			onPointerDown={event => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div className="tr-attach-preview-panel">
				<div className="tr-attach-preview-head">
					<span className="tr-attach-preview-name" title={item.name}>
						{item.name}
					</span>
					<button
						type="button"
						className="tr-attach-preview-close"
						aria-label={t("settings.close")}
						onClick={onClose}
					>
						<X size={14} aria-hidden="true" />
					</button>
				</div>
				{body}
			</div>
		</div>,
		document.body,
	);
}

async function copyReference(item: AttachmentRef): Promise<void> {
	try {
		await navigator.clipboard?.writeText(`[Attachment] blob://${item.hash} (${item.name})`);
	} catch {
		// clipboard unavailable (non-secure context) — nothing sensible to do
	}
}

function AttachmentCard({ item, host }: { item: AttachmentRef; host?: ToolRenderHost }): ReactNode {
	const [size, setSize] = useState<number | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const stat = host?.attachment?.stat;
	const attachmentHost = host?.attachment;

	useEffect(() => {
		if (!stat) return;
		let cancelled = false;
		stat(item.hash)
			.then((result: AttachmentStatResult) => {
				if (!cancelled && result.exists) setSize(result.size);
			})
			.catch(() => {
				// Size is optional chrome; a failed probe hides it.
			});
		return () => {
			cancelled = true;
		};
	}, [item.hash, stat]);

	return (
		<div className="tr-file-card tr-attach-card" role="listitem">
			<span className="tr-file-card-top">
				<span className="tr-file-card-badge" aria-hidden="true">
					{extBadge(item.name) || "•"}
				</span>
				<span className="tr-file-card-name" title={item.name}>
					{item.name}
				</span>
			</span>
			{size !== null && <span className="tr-attach-size">{formatBytes(size)}</span>}
			<span className="tr-file-card-actions">
				{attachmentHost?.read && (
					<button type="button" className="tr-file-card-btn" onClick={() => setPreviewing(true)}>
						{t("tools.attachmentPreview")}
					</button>
				)}
				<button
					type="button"
					className="tr-file-card-btn"
					title={t("tools.attachmentCopyRef")}
					onClick={() => void copyReference(item)}
				>
					{t("tools.attachmentCopyRef")}
				</button>
			</span>
			{previewing && attachmentHost && (
				<AttachmentPreview item={item} host={attachmentHost} onClose={() => setPreviewing(false)} />
			)}
		</div>
	);
}

export function UserAttachmentCards({
	refs,
	host,
}: {
	refs: readonly AttachmentRef[];
	host?: ToolRenderHost;
}): ReactNode | null {
	if (refs.length === 0) return null;
	return (
		<div className="tr-file-cards tr-attach-cards" role="list" aria-label={t("tools.attachmentCards")}>
			{refs.map(item => (
				<AttachmentCard key={item.hash} item={item} host={host} />
			))}
		</div>
	);
}
