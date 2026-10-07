import { getLocaleSnapshot, subscribeLocale, t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { RpcClient } from "../../lib/rpc";

/** One string per language, English as the fallback when a translation is
 *  absent — a partially translated catalogue still reads. */
interface LocalizedText {
	readonly en: string;
	readonly zh: string | null;
}

/** Resolve a bilingual field against the active locale. */
function localize(text: LocalizedText, locale: string): string {
	return locale.toLowerCase().startsWith("zh") && text.zh ? text.zh : text.en;
}

/**
 * Start-from picker: which shape this creation begins from.
 *
 * A radio row, not a launcher. Picking a template records the choice and stops
 * there — the creation happens when the composer is submitted, not when a card
 * is clicked. Deferring it is what lets a person change their mind before
 * committing to a session.
 *
 * "Start blank" is the first option of the same radio group rather than a
 * separate affordance: choosing nothing is a decision about the shape, not the
 * absence of one. Selecting the active card again clears it, so the row is
 * reversible without a second control.
 *
 * This sits with the composer rather than above it in the chip rows. A saved
 * creation template (parameters a person filled in before) is a different thing
 * and keeps its own rail there; this one answers "what should this look like".
 *
 * Cards preview the template's own baked example rather than showing an
 * initial. That is the whole reason a template ships an example: picking a shape
 * you have seen renders is a different act from picking a name. The example
 * loads on hover or selection rather than on mount — a rail of live documents
 * nobody looked at is a rail that costs a frame tree per card.
 */
interface BundledTemplateSummary {
	readonly id: string;
	/** Creation surface this shape belongs to; a plain string like the saved
	 *  template rail's, because the renderer does not import daemon types. */
	readonly tab: string;
	/** Card label and tooltip, each bilingual — the daemon ships both and the
	 *  renderer resolves against the active locale. */
	readonly title: LocalizedText;
	readonly description: LocalizedText;
}

export function StartFromPicker({
	rpc,
	value,
	onChange,
}: {
	rpc: RpcClient;
	/** The chosen shape, or `null` for a blank start. */
	value: string | null;
	onChange(value: string | null): void;
}): ReactNode {
	const [templates, setTemplates] = useState<readonly BundledTemplateSummary[]>([]);

	// Fetched on mount. The composer only mounts this while the design mode is
	// armed, so there is no gate to keep — an ordinary welcome page never
	// produces this RPC.
	useEffect(() => {
		let cancelled = false;
		void rpc
			.request<{ templates: BundledTemplateSummary[] }>("creation.templates.bundled", {})
			.then(res => {
				if (!cancelled) setTemplates(res?.templates ?? []);
			})
			.catch(() => {
				// A missing list leaves the blank option, which is the state the
				// picker starts in anyway — a failed fetch costs nothing here.
				if (!cancelled) setTemplates([]);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc]);

	const pick = useCallback((id: string | null) => onChange(id), [onChange]);
	const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot);

	return (
		<div className="gui-creation-startfrom">
			<span className="gui-creation-startfrom-label">{t("creation start from")}</span>
			<div className="gui-creation-startfrom-row" role="radiogroup" aria-label={t("creation start from")}>
				<button
					type="button"
					role="radio"
					aria-checked={value === null}
					className={`gui-creation-startcard${value === null ? " gui-creation-startcard--on" : ""}`}
					title={t("creation start blank hint")}
					onClick={() => pick(null)}
				>
					<span className="gui-creation-startcard-thumb gui-creation-startcard-thumb--blank" aria-hidden="true">
						+
					</span>
					<span className="gui-creation-startcard-name">{t("creation start blank")}</span>
				</button>
				{templates.map(tpl => (
					<TemplateCard
						key={tpl.id}
						rpc={rpc}
						template={tpl}
						active={value === tpl.id}
						onPick={pick}
						locale={locale}
					/>
				))}
			</div>
		</div>
	);
}

/** One template's card: the baked example as its thumbnail, loaded when the
 *  card is hovered or selected.
 *
 *  Hovering previews; it does not select. Reading a row of shapes means moving
 *  across it, and a row that commits as the pointer passes over it makes
 *  comparing two templates impossible — the person cannot look at the second
 *  one without losing the first. Selection is the click, and only the click.
 */
function TemplateCard({
	rpc,
	template,
	active,
	onPick,
	locale,
}: {
	rpc: RpcClient;
	template: BundledTemplateSummary;
	/** Selected — its preview stays loaded even after the pointer leaves. */
	active: boolean;
	/** The row's selection setter. Called from the click only. */
	onPick(id: string | null): void;
	/** Active locale, so the card's label follows a language switch. */
	locale: string;
}): ReactNode {
	const [wantPreview, setWantPreview] = useState(false);
	const [html, setHtml] = useState<string | null>(null);

	const wanted = wantPreview || active;

	useEffect(() => {
		if (!wanted || html !== null) return;
		let cancelled = false;
		void rpc
			.request<{ html: string }>("creation.templates.bundledExample", { id: template.id })
			.then(res => {
				if (!cancelled) setHtml(res?.html ?? "");
			})
			.catch(() => {
				// No preview for this one: the card falls back to its initial, which
				// is what it showed before previews existed.
				if (!cancelled) setHtml("");
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, template.id, wanted, html]);

	const on = active;
	const title = localize(template.title, locale);
	const description = localize(template.description, locale);
	return (
		<button
			type="button"
			role="radio"
			aria-checked={on}
			className={`gui-creation-startcard gui-creation-startcard--${template.tab}${on ? " gui-creation-startcard--on" : ""}`}
			title={description}
			onMouseEnter={() => setWantPreview(true)}
			onMouseLeave={() => setWantPreview(false)}
			onFocus={() => setWantPreview(true)}
			onBlur={() => setWantPreview(false)}
			onClick={() => onPick(active ? null : template.id)}
		>
			<span className="gui-creation-startcard-thumb" aria-hidden="true">
				{html ? (
					// The example is a document we ship, run with scripts the way the
					// artifact and file previewers already run them — a deck navigates
					// inside its own frame by keyboard, wheel and swipe, so the
					// host must not try to drive it.
					<iframe
						className="gui-creation-startcard-frame"
						title={description}
						sandbox="allow-scripts"
						srcDoc={html}
						// Decks read their own width, so a fixed 0 width would hide
						// everything; the frame is inert to the pointer instead.
						tabIndex={-1}
					/>
				) : (
					template.id.charAt(0).toUpperCase()
				)}
			</span>
			<span className="gui-creation-startcard-name">{title}</span>
		</button>
	);
}
