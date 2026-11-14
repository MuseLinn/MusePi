/** What one browser step changed. Rendered inside the step's expanded
 *  detail; `null` (no comparable pair) renders nothing rather than claiming
 *  the page stood still. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { BrowserStepChange } from "./browser-activity";

function changeLabel(key: BrowserStepChange["key"]): string {
	switch (key) {
		case "pageTitle":
			return t("tools.browserPage");
		case "url":
			return t("tools.browserCurrentUrl");
		case "scrollY":
			return t("tools.browserScrollY");
		case "loading":
			return t("tools.browserLoading");
	}
}

function changeValue(value: string | number | boolean): string {
	if (typeof value === "boolean") return value ? t("tools.browserYes") : t("tools.browserNo");
	return String(value);
}

export function StepChanges({ changes }: { changes: BrowserStepChange[] | null }): ReactNode {
	if (changes === null) return null;
	return (
		<div className="tv-browser-step-changes">
			<span className="tv-browser-step-changes-head">
				{changes.length > 0 ? t("tools.browserStepChanges") : t("tools.browserStepUnchanged")}
			</span>
			{changes.length > 0 && (
				<dl className="tv-browser-step-change-list">
					{changes.map(change => (
						<div className="tv-browser-step-change" key={change.key}>
							<dt>{changeLabel(change.key)}</dt>
							<dd>
								<span className="tv-browser-step-before">{changeValue(change.before)}</span>
								<span className="tv-browser-step-arrow" aria-hidden="true">
									→
								</span>
								<span className="tv-browser-step-after">{changeValue(change.after)}</span>
							</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
}

/** What the agent saw before this step. The transcript reuses the previous
 *  step's post-action thumbnail: same pixels, no extra capture, and the label
 *  is honest because the previous step ended on this page. */
export function StepReceipt({ thumbnail }: { thumbnail: string | undefined }): ReactNode {
	if (!thumbnail) return null;
	return (
		<figure className="tv-browser-step-receipt">
			<img src={thumbnail} alt="" loading="lazy" />
			<figcaption>{t("tools.browserStepBefore")}</figcaption>
		</figure>
	);
}
