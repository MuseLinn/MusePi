import { Markdown, t } from "@musepi/guest-client";
import { ArrowLeft, FileWarning, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";

/**
 * Artifacts panel (设计板 W3) — the consumer side of the design-preset
 * product contract. The daemon scans the workspace for
 * `artifact.manifest.json` sidecars (mode:design:artifact) and validates
 * each through the shared manifest module; this panel renders what came
 * back:
 *
 *   ① list — one card per artifact (kind/renderer badges, title,
 *      description, exports); invalid manifests are listed too, with their
 *      validation errors, so an agent's broken manifest is fixable from
 *      the panel instead of silently missing.
 *   ② viewer — the manifest's entry file rendered by renderer:
 *      html/deck-html in a sandboxed iframe, markdown through the shared
 *      Markdown component, react-component as source (no runtime in the
 *      panel).
 */

/** One scanned artifact (daemon artifact.list → WorkspaceArtifact). */
interface ArtifactRow {
	dir: string;
	dirName: string;
	title: string;
	entry: string;
	kind: string;
	renderer: string;
	exports?: string[];
	description?: string;
	errors?: string[];
}

interface ScanResult {
	rootPath: string;
	truncated: boolean;
	artifacts: ArtifactRow[];
}

/** Renderers that show a live iframe. */
const IFRAME_RENDERERS = new Set(["html", "deck-html"]);
/** Renderers that show source instead of a live preview. */
const SOURCE_RENDERERS = new Set(["react-component"]);

/** Preview viewport widths (设计板 08 设计板 frame: 桌面/平板/移动). */
const VIEWPORTS = [
	{ id: "desktop", width: 0 },
	{ id: "tablet", width: 768 },
	{ id: "mobile", width: 390 },
] as const;

type ViewportId = (typeof VIEWPORTS)[number]["id"];

function kindLabel(kind: string): string {
	// kind/renderer are contract enums (page/component/poster/deck) — shown
	// verbatim like file extensions, not run through i18n.
	return kind || "—";
}

/** Artifacts body for the right panel (`artifacts` surface). */
export function ArtifactsPanel({ rpc, cwd }: { rpc: RpcClient | null; cwd?: string }): ReactNode {
	const [scan, setScan] = useState<ScanResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<ArtifactRow | null>(null);
	const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null);
	const [contentError, setContentError] = useState<string | null>(null);
	/** Live-iframe preview width (设计板 frame: 桌面/平板/移动). */
	const [viewport, setViewport] = useState<ViewportId>("desktop");

	const load = useCallback(async (): Promise<void> => {
		if (!rpc || !cwd) return;
		setLoading(true);
		setError(null);
		try {
			const res = await rpc.request<ScanResult>("artifact.list", { cwd });
			setScan(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setScan(null);
		} finally {
			setLoading(false);
		}
	}, [rpc, cwd]);

	useEffect(() => {
		setSelected(null);
		setContent(null);
		setContentError(null);
		void load();
	}, [load]);

	const openArtifact = useCallback(
		async (a: ArtifactRow): Promise<void> => {
			if (!rpc || !cwd) return;
			setSelected(a);
			setContent(null);
			setContentError(null);
			try {
				const res = await rpc.request<{ text?: string; truncated?: boolean; error?: string }>("artifact.read", {
					cwd,
					dir: a.dir,
					entry: a.entry,
				});
				if (res?.error) setContentError(res.error);
				else setContent({ text: res?.text ?? "", truncated: res?.truncated === true });
			} catch (err) {
				setContentError(err instanceof Error ? err.message : String(err));
			}
		},
		[rpc, cwd],
	);

	if (!cwd) {
		return (
			<div className="gui-pane-tab-empty">
				<span className="gui-pane-tab-empty-icon">
					<Icon name="stack" />
				</span>
				<p className="gui-pane-tab-empty-title">{t("select a session")}</p>
				<p className="gui-pane-tab-empty-hint">{t("artifacts empty hint")}</p>
			</div>
		);
	}

	if (selected) {
		const live = IFRAME_RENDERERS.has(selected.renderer);
		const source = SOURCE_RENDERERS.has(selected.renderer);
		const markdown = selected.renderer === "markdown";
		return (
			<div className="gui-art-viewer">
				<div className="gui-art-viewer-bar">
					<button
						type="button"
						className="gui-btn gui-btn-icon"
						title={t("back to artifacts")}
						onClick={() => {
							setSelected(null);
							setContent(null);
							setContentError(null);
						}}
					>
						<ArrowLeft size={13} />
					</button>
					<div className="gui-art-viewer-heading">
						<span className="gui-art-viewer-title" title={selected.entry}>
							{selected.title}
						</span>
						<span className="gui-art-badge">{kindLabel(selected.kind)}</span>
						<span className="gui-art-badge gui-art-badge--muted">{selected.renderer}</span>
					</div>
					{selected.exports && selected.exports.length > 0 && (
						<span className="gui-art-exports" title={t("exports label")}>
							{selected.exports.join(" · ")}
						</span>
					)}
				</div>
				{contentError ? (
					<div className="gui-art-note gui-art-note--error">{contentError}</div>
				) : !content ? (
					<div className="gui-art-note">{t("loading")}</div>
				) : (
					<>
						{content.truncated && <div className="gui-art-note">{t("artifact truncated")}</div>}
						{live ? (
							<>
								{/* Viewport switch (设计板 frame: 桌面/平板/移动) — the
								 * iframe clamps to the device width, centered. */}
								<div className="gui-art-viewport-row">
									{VIEWPORTS.map(v => (
										<button
											key={v.id}
											type="button"
											className={`gui-art-viewport${viewport === v.id ? " gui-art-viewport--on" : ""}`}
											title={t(`artifacts viewport ${v.id}`)}
											onClick={() => setViewport(v.id)}
										>
											{t(`artifacts viewport ${v.id}`)}
										</button>
									))}
								</div>
								<div className="gui-art-frame-wrap">
									<iframe
										className="gui-art-frame"
										title={selected.title}
										sandbox="allow-scripts"
										srcDoc={content.text}
										style={
											viewport === "desktop"
												? undefined
												: { width: VIEWPORTS.find(v => v.id === viewport)?.width, maxWidth: "100%" }
										}
									/>
								</div>
							</>
						) : markdown ? (
							<div className="gui-art-markdown">
								<Markdown text={content.text} />
							</div>
						) : source ? (
							<>
								<div className="gui-art-note">{t("artifact code view hint")}</div>
								<pre className="gui-art-source">{content.text}</pre>
							</>
						) : (
							<pre className="gui-art-source">{content.text}</pre>
						)}
					</>
				)}
			</div>
		);
	}

	return (
		<div className="gui-art-list">
			<div className="gui-art-list-head">
				<span className="gui-group-label">{t("artifacts")}</span>
				<button type="button" className="gui-btn gui-btn-icon" title={t("refresh")} onClick={() => void load()}>
					<RefreshCw size={13} className={loading ? "gui-art-spinning" : undefined} />
				</button>
			</div>
			{error ? (
				<div className="gui-art-note gui-art-note--error">{error}</div>
			) : !scan ? (
				<div className="gui-art-note">{t("loading")}</div>
			) : scan.artifacts.length === 0 ? (
				<div className="gui-pane-tab-empty">
					<span className="gui-pane-tab-empty-icon">
						<Icon name="stack" />
					</span>
					<p className="gui-pane-tab-empty-title">{t("artifacts empty")}</p>
					<p className="gui-pane-tab-empty-hint">{t("artifacts empty hint")}</p>
				</div>
			) : (
				<>
					{scan.truncated && <div className="gui-art-note">{t("artifacts scan truncated")}</div>}
					<div className="gui-art-cards">
						{scan.artifacts.map(a => (
							<button
								type="button"
								key={a.dir}
								className={`gui-art-card${a.errors ? " gui-art-card--invalid" : ""}`}
								onClick={() => {
									if (a.errors) return;
									void openArtifact(a);
								}}
							>
								<div className="gui-art-card-top">
									<span className="gui-art-card-name" title={a.dir}>
										{a.title}
									</span>
									{a.errors ? (
										<span className="gui-art-badge gui-art-badge--danger">
											<FileWarning size={11} />
											{t("artifact manifest invalid")}
										</span>
									) : (
										<span className="gui-art-badge">{kindLabel(a.kind)}</span>
									)}
								</div>
								{a.description && <p className="gui-art-card-desc">{a.description}</p>}
								<div className="gui-art-card-meta">
									<span title={a.dir}>{a.dirName}</span>
									{!a.errors && a.renderer && (
										<span className="gui-art-badge gui-art-badge--muted">{a.renderer}</span>
									)}
								</div>
								{a.errors && (
									<ul className="gui-art-card-errors">
										{a.errors.map(e => (
											<li key={e}>{e}</li>
										))}
									</ul>
								)}
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}
