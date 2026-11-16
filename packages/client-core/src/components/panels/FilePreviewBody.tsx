/**
 * The file panel's preview body, one renderer per preview kind. Kept apart from
 * `FilePanel` so a preview can be rendered (and tested) without the tree, the
 * RPC or the selection state that produced it.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { FilePreviewResult } from "../../lib/file-preview";

export function FilePreviewBody({ preview }: { preview: FilePreviewResult }): ReactNode {
	if (preview.kind === "error") {
		// A path that vanished between the tree read and the preview read is a
		// normal staleness case on a phone; the raw ENOENT is not user copy.
		const missing = /ENOENT|no such file/i.test(preview.message);
		return <p className="sh-panel-error">{missing ? t("guest.fileUnavailable") : preview.message}</p>;
	}
	if (preview.kind === "text") {
		return (
			<>
				<pre className="sh-files-preview-text">{preview.text}</pre>
				{preview.truncated && <p className="sh-panel-muted">{t("guest.previewTruncated")}</p>}
			</>
		);
	}
	if (preview.kind === "image") {
		return <img className="sh-files-preview-image" src={preview.url} alt={preview.name} />;
	}
	if (preview.kind === "audio") {
		return <audio className="sh-files-preview-media" src={preview.url} controls preload="metadata" />;
	}
	if (preview.kind === "video") {
		return <video className="sh-files-preview-media" src={preview.url} controls playsInline preload="metadata" />;
	}
	return (
		<div className="sh-files-preview-binary">
			<p className="sh-panel-muted">{t("guest.previewBinary.info", { mime: preview.mime || "—" })}</p>
			<a className="sh-btn" href={preview.url} download={preview.name}>
				{t("settings.download")}
			</a>
		</div>
	);
}
