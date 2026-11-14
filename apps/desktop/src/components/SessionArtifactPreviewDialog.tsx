import { t } from "@musepi/client-core";
import { formatBytes } from "@musepi/pi-utils/format";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { DialogFrame } from "./DialogFrame";

export interface SessionArtifactPreviewRequest {
	sessionId: string;
	id: string;
}

interface SessionArtifactPreview {
	text: string;
	truncated: boolean;
	totalBytes: number;
}

export function SessionArtifactPreviewDialog({
	rpc,
	request,
	onClose,
}: {
	rpc: RpcClient | null;
	request: SessionArtifactPreviewRequest | null;
	onClose(): void;
}): ReactNode {
	const [loading, setLoading] = useState(false);
	const [preview, setPreview] = useState<SessionArtifactPreview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [edges, setEdges] = useState({ top: false, bottom: false });
	const generation = useRef(0);
	const bodyRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!request) return;
		const current = ++generation.current;
		setLoading(true);
		setError(null);
		setPreview(null);
		void (async () => {
			try {
				if (!rpc) throw new Error("Daemon unavailable");
				const next = await rpc.request<SessionArtifactPreview>("session.artifactRead", request);
				if (current === generation.current) setPreview(next);
			} catch (err) {
				if (current === generation.current) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (current === generation.current) setLoading(false);
			}
		})();
		return () => {
			generation.current += 1;
		};
	}, [rpc, request]);

	useEffect(() => {
		if (!request || !bodyRef.current) return;
		const element = bodyRef.current;
		const measure = (): void => {
			const slack = element.scrollHeight - element.clientHeight;
			setEdges({
				top: element.scrollTop > 1,
				bottom: slack > 1 && element.scrollTop < slack - 1,
			});
		};
		measure();
		element.addEventListener("scroll", measure, { passive: true });
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const child of Array.from(element.children)) observer.observe(child);
		return () => {
			element.removeEventListener("scroll", measure);
			observer.disconnect();
		};
	}, [request, preview, error, loading]);

	const title = t("tools.rawArtifactTitle", { id: request?.id ?? "—" });
	return (
		<DialogFrame open={request !== null} onClose={onClose} label={title} className="gui-dialog--artifact-preview">
			<div className="gui-dialog-head">
				<h3 className="gui-dialog-title">{title}</h3>
				<button type="button" className="gui-btn" onClick={onClose}>
					{t("annotation.panelClose")}
				</button>
			</div>
			<div
				ref={bodyRef}
				className="gui-artifact-preview-body"
				data-scrolled-top={edges.top ? "true" : "false"}
				data-scrolled-bottom={edges.bottom ? "true" : "false"}
			>
				{loading ? (
					<p className="gui-settings-row-desc">{t("settings.loading")}</p>
				) : error ? (
					<p role="alert" className="gui-settings-row-desc text-[var(--color-warning)]">
						{error}
					</p>
				) : preview ? (
					<>
						{preview.truncated && (
							<p className="gui-artifact-preview-notice">
								{t("tools.rawArtifactTruncated", {
									shown: formatBytes(new Blob([preview.text]).size),
									total: formatBytes(preview.totalBytes),
								})}
							</p>
						)}
						<pre className="gui-artifact-preview-text">{preview.text}</pre>
					</>
				) : null}
			</div>
		</DialogFrame>
	);
}
