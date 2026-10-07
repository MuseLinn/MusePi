import { t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

/**
 * Start-from picker: which shape this creation begins from.
 *
 * A radio row, not a launcher. Picking a template records the choice and stops
 * there — the creation happens when the composer is submitted, not when a card
 * is clicked. That is the open-design shape (`StartFromPicker` in its
 * NewProjectPanel), and it is what lets a person change their mind before
 * committing to a session.
 *
 * "Start blank" is the first option of the same radio group rather than a
 * separate affordance: choosing nothing is a decision about the shape, not the
 * absence of one. Selecting the active card again clears it, so the row is
 * reversible without a second control.
 *
 * This sits in the creation surface rather than beside the composer. A saved
 * creation template (parameters a person filled in before) is a different thing
 * and keeps its own rail there; this one answers "what should this look like".
 */
interface BundledTemplateSummary {
	readonly id: string;
	/** Creation surface this shape belongs to; a plain string like the saved
	 *  template rail's, because the renderer does not import daemon types. */
	readonly tab: string;
	readonly summary: string;
}

export function StartFromPicker({
	rpc,
	active,
	value,
	onChange,
}: {
	rpc: RpcClient;
	/** Mounted only while the creation surface is open, like the chip row. */
	active: boolean;
	/** The chosen shape, or `null` for a blank start. */
	value: string | null;
	onChange(value: string | null): void;
}): ReactNode {
	const [templates, setTemplates] = useState<readonly BundledTemplateSummary[]>([]);

	// Only while expanded: an ordinary welcome page must not produce creation
	// RPCs (the same rule the template rail follows).
	useEffect(() => {
		if (!active) return;
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
	}, [active, rpc]);

	const pick = useCallback((id: string | null) => onChange(id), [onChange]);

	// The row is a single radio group over one creation's shapes: blank plus the
	// bundled templates for the surface currently picked.
	const shown = templates;

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
					<span className="gui-creation-startcard-thumb" aria-hidden="true">
						+
					</span>
					<span className="gui-creation-startcard-name">{t("creation start blank")}</span>
				</button>
				{shown.map(tpl => {
					const on = value === tpl.id;
					return (
						<button
							key={tpl.id}
							type="button"
							role="radio"
							aria-checked={on}
							className={`gui-creation-startcard gui-creation-startcard--${tpl.tab}${on ? " gui-creation-startcard--on" : ""}`}
							title={tpl.summary}
							onClick={() => pick(on ? null : tpl.id)}
						>
							<span className="gui-creation-startcard-thumb" aria-hidden="true">
								{tpl.id.charAt(0).toUpperCase()}
							</span>
							<span className="gui-creation-startcard-name">{tpl.id}</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}
