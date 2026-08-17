import { type TranslationKey, t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

/**
 * UI metadata for one setting, as returned by the daemon's
 * settings.schema RPC (the same single source of truth the TUI settings
 * panel renders — the GUI must not drift from it).
 */
export interface SchemaItem {
	key: string;
	type: "boolean" | "enum" | "string" | "number";
	default?: unknown;
	ui?: {
		label: string;
		description?: string;
		group?: string;
		options?: { value: string; label: string; description?: string }[];
		/** Condition function name (TUI settings-defs CONDITIONS parity):
		 * the item only shows when the referenced setting holds. */
		condition?: string;
	};
}

/**
 * Condition gates mirrored from the TUI's CONDITIONS map
 * (packages/coding-agent/src/modes/components/settings-defs.ts) — the
 * daemon schema sends the condition NAME, the GUI evaluates it against
 * the fetched values. Unknown names default to visible (parity-safe).
 */
const CONDITIONS: Record<string, (values: Record<string, unknown>) => boolean> = {
	mnemopiActive: v => v["memory.backend"] === "mnemopi",
	hindsightActive: v => v["memory.backend"] === "hindsight",
	autolearnActive: v => v["autolearn.enabled"] === true,
	advisorEnabled: v => v["advisor.enabled"] === true,
	autoThinkingActive: v => v["defaultThinkingLevel"] === "auto",
	usageAwareFallbackEnabled: v => v["retry.usageAwareFallback"] === true,
	planModeEnabled: v => v["plan.enabled"] === true,
	lspActive: v => v["lsp.enabled"] === true,
	summarizeActive: v => v["read.summarize.enabled"] === true,
};

/**
 * Generic settings renderer driven by daemon schema metadata.
 * Boolean → toggle, enum → select, string → input (credentials render
 * masked and keep the stored value unless replaced), number → input.
 * Labels/descriptions resolve through the app locale (t()), falling
 * back to the schema's English text when untranslated.
 */
export function SchemaSettings({
	items,
	values,
	onChange,
	error,
}: {
	items: SchemaItem[];
	values: Record<string, unknown>;
	onChange(key: string, value: unknown): void;
	error?: string | null;
}): ReactNode {
	// Preserve schema order, grouping rows under their ui.group headings.
	const groups = new Map<string, SchemaItem[]>();
	for (const item of items) {
		const g = item.ui?.group ?? "";
		const list = groups.get(g) ?? [];
		list.push(item);
		groups.set(g, list);
	}
	const isCredential = (item: SchemaItem): boolean => {
		// Credential keys are masked by convention (daemon never echoes
		// them back — values[key] is undefined here even when stored).
		return item.type === "string" && /api[_-]?key|token|secret/i.test(item.key);
	};
	return (
		<>
			{error && <div className="px-1 pb-1 text-[12.5px] text-[var(--color-warning)]">{error}</div>}
			{[...groups.entries()].map(([group, list]) => {
				// Condition-gated rows (memory backend, LSP/summarize
				// toggles…): hidden rows animate in/out via the shared
				// Reveal standard. The GROUP is a Reveal too — a group whose
				// items are ALL hidden (e.g. the whole Hindsight block while
				// another backend is selected) collapses heading + rows as one
				// unit instead of popping into existence; groups with any
				// visible item stay open and only their rows animate.
				const visible = list.filter(item => {
					const cond = item.ui?.condition;
					return !cond || (CONDITIONS[cond]?.(values) ?? true);
				});
				return (
					<Reveal key={group || "__root"} open={visible.length > 0}>
						{group !== "" && <div className="gui-settings-group-h">{t(group as TranslationKey)}</div>}
						{list.map(item => {
							const value = values[item.key] ?? item.default;
							const label = item.ui?.label ?? item.key;
							const desc = item.ui?.description;
							const credential = isCredential(item);
							const cond = item.ui?.condition;
							const shown = !cond || (CONDITIONS[cond]?.(values) ?? true);
							return (
								<Reveal key={item.key} open={shown}>
									<div className="gui-settings-row">
										<div className="min-w-0 flex-1">
											<div className="gui-settings-row-label">{t(label as TranslationKey)}</div>
											{desc && (
												<div className="text-[12.5px] leading-relaxed text-[var(--color-text-muted)]">
													{t(desc as TranslationKey)}
												</div>
											)}
										</div>
										{item.type === "boolean" ? (
											<button
												type="button"
												role="switch"
												aria-checked={value === true}
												className={`gui-toggle${value === true ? " gui-toggle--on" : ""}`}
												onClick={() => onChange(item.key, value !== true)}
											>
												<span className="gui-toggle-knob" />
											</button>
										) : item.type === "enum" && item.ui?.options ? (
											<select
												className="gui-settings-select !w-auto max-w-[240px]"
												value={typeof value === "string" ? value : ""}
												onChange={e => onChange(item.key, e.target.value)}
											>
												{item.ui.options.map(opt => (
													<option
														key={opt.value}
														value={opt.value}
														title={opt.description ? t(opt.description as TranslationKey) : undefined}
													>
														{t(opt.label as TranslationKey)}
													</option>
												))}
											</select>
										) : item.type === "number" ? (
											<input
												type="number"
												className="gui-settings-select !w-auto max-w-[120px]"
												value={typeof value === "number" ? value : 0}
												onChange={e => onChange(item.key, Number(e.target.value))}
											/>
										) : (
											<input
												type={credential ? "password" : "text"}
												className="gui-settings-select !w-auto max-w-[240px]"
												placeholder={
													credential
														? t("keep stored credential unless replaced")
														: typeof item.default === "string"
															? item.default
															: undefined
												}
												defaultValue={credential ? "" : typeof value === "string" ? value : ""}
												key={`${item.key}:${String(value)}`}
												onBlur={e => {
													if (credential && e.target.value === "") return; // keep stored
													onChange(item.key, e.target.value);
												}}
											/>
										)}
									</div>
								</Reveal>
							);
						})}
					</Reveal>
				);
			})}
		</>
	);
}
