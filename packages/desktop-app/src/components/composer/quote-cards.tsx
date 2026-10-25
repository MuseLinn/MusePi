import type { DisplayContext } from "@musepi/client-core/src/messages/display-context";
import {
	browserAnnotationTargetCount,
	displayContextQuote,
	withDisplayContextComment,
} from "@musepi/client-core/src/messages/display-context";
import { Eye, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";

export function QuoteCards({
	contexts,
	onRemove,
	onChange,
}: {
	contexts: DisplayContext[];
	onRemove(index: number): void;
	onChange(index: number, context: DisplayContext): void;
}): ReactNode {
	const [preview, setPreview] = useState<number | null>(null);
	return (
		<div className="gui-quote-contexts">
			{contexts.map((context, index) => (
				<div className="gui-quote-card" key={`${index}-${displayContextQuote(context).slice(0, 32)}`}>
					<div className="gui-quote-context-body">
						{context.kind === "browser-annotation" ? (
							<div className="gui-quote-context-meta">
								<span className="gui-quote-context-page" title={context.pageUrl}>
									{context.pageUrl}
								</span>
								<span className="gui-quote-context-count">{browserAnnotationTargetCount(context)}</span>
							</div>
						) : context.kind === "file-quote" ? (
							<div className="gui-quote-context-meta">
								<span className="gui-quote-context-page" title={context.path}>
									{context.path}
									{context.startLine !== undefined && context.endLine !== undefined
										? `:${context.startLine}-${context.endLine}`
										: ""}
								</span>
								{context.language ? <span className="gui-quote-context-count">{context.language}</span> : null}
							</div>
						) : (
							<div className="gui-quote-text">{context.quote}</div>
						)}
						<label className="gui-quote-comment-label">
							<span>{t("annotation.commentLabel")}</span>
							<input
								className="gui-quote-comment"
								value={context.comment ?? ""}
								placeholder={t("annotation.commentPlaceholder")}
								onChange={event => onChange(index, withDisplayContextComment(context, event.target.value))}
							/>
						</label>
						{preview === index && (
							<div className="gui-quote-context-preview">
								{context.kind === "browser-annotation" && context.image ? (
									<img
										className="gui-quote-context-image"
										src={context.image}
										alt={t("settings.previewImage")}
									/>
								) : null}
								<pre>{displayContextQuote(context)}</pre>
							</div>
						)}
					</div>
					<button
						type="button"
						className="gui-quote-preview"
						onClick={() => setPreview(current => (current === index ? null : index))}
						title={t("general.togglePreview")}
						aria-label={t("general.togglePreview")}
						aria-expanded={preview === index}
					>
						<Eye size={12} />
					</button>
					<button
						type="button"
						className="gui-quote-close"
						onClick={() => onRemove(index)}
						title={t("general.removeQuote")}
						aria-label={t("general.removeQuote")}
					>
						<X size={12} />
					</button>
				</div>
			))}
		</div>
	);
}
