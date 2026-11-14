/**
 * In-app upload confirmation for the managed browser.
 *
 * Chromium never shows a native file dialog in this browser: the page's
 * chooser is intercepted over CDP and the decision lands here. The same card
 * is used when the agent calls `tab.uploadFile`, so a local file can never
 * reach a website silently. Site requests pick files from this card; agent
 * requests already know the files and only need a yes/no.
 *
 * Rendered inside the pane (over the `<webview>`), so it layers like any
 * other DOM overlay.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import "../styles/gui-browser-upload.css";

export function BrowserUploadDialog({
	request,
	onCancel,
	onChoose,
	onAllowAgent,
}: {
	request: ManagedBrowserUploadRequest | null;
	onCancel(): void;
	onChoose(request: ManagedBrowserUploadRequest): void;
	onAllowAgent(requestId: string): void;
}): ReactNode {
	if (!request) return null;
	const site = request.site;
	const host = site.host || t("tools.browserUploadSiteFallback");
	const accept = request.accept.join(", ");
	const isAgent = request.mode === "agent";
	return (
		<div
			className="gui-upload-overlay"
			role="dialog"
			aria-modal="true"
			aria-label={t("tools.browserUploadRequestTitle")}
		>
			<div className="gui-upload-card">
				<div className="gui-upload-heading">
					<span className="gui-upload-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
							<title>{t("tools.browserUploadRequestTitle")}</title>
							<path d="M12 16V4m0 0L7 9m5-5 5 5" strokeLinecap="round" strokeLinejoin="round" />
							<path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" strokeLinecap="round" />
						</svg>
					</span>
					<div className="gui-upload-titles">
						<div className="gui-upload-title">{t("tools.browserUploadRequestTitle")}</div>
						<div className="gui-upload-site" title={site.url}>
							<span className="gui-upload-host">{host}</span>
							{site.title ? <span className="gui-upload-page-title">{site.title}</span> : null}
						</div>
					</div>
				</div>

				<p className="gui-upload-description">
					{isAgent
						? t("tools.browserUploadAgentDescription", { host })
						: t("tools.browserUploadRequestDescription")}
				</p>

				{isAgent && request.names.length > 0 ? (
					<ul className="gui-upload-files">
						{request.names.map((name, index) => (
							<li key={`${index}:${name}`} className="gui-upload-file" title={name}>
								{name}
							</li>
						))}
					</ul>
				) : null}

				{accept ? (
					<div className="gui-upload-accept" title={accept}>
						{t("tools.browserUploadAccept", { accept })}
					</div>
				) : null}
				{request.multiple ? <div className="gui-upload-hint">{t("tools.browserUploadMultiple")}</div> : null}

				<div className="gui-upload-actions">
					<button type="button" className="gui-upload-action" onClick={onCancel}>
						{t("tools.browserUploadCancel")}
					</button>
					{isAgent ? (
						<button
							type="button"
							className="gui-upload-action gui-upload-action-primary"
							onClick={() => onAllowAgent(request.requestId)}
						>
							{t("tools.browserUploadAllow")}
						</button>
					) : (
						<button
							type="button"
							className="gui-upload-action gui-upload-action-primary"
							onClick={() => onChoose(request)}
						>
							{t("tools.browserUploadChoose")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
