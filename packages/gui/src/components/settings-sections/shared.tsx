import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useState } from "react";
import { Icon } from "../../vendor/oc-icons";

/** Openchamber-style number stepper: [−] input [+] unit, plus reset. */
export function NumberStepper({
	label,
	value,
	min,
	max,
	step = 1,
	unit,
	defaultValue,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	unit: "px" | "%";
	defaultValue: number;
	onChange(next: number): void;
}): ReactNode {
	// Local draft while typing; null mirrors the committed prop so the
	// field never fights free editing or snaps mid-keystroke.
	const [draft, setDraft] = useState<string | null>(null);
	const shown = draft ?? String(value);
	const clamp = (v: number): number => Math.min(max, Math.max(min, v));
	const commit = (raw: string | number): void => {
		setDraft(null);
		const v = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isNaN(v)) onChange(clamp(v));
	};
	return (
		<div className="gui-settings-field-control">
			<div className="gui-settings-stepper">
				<button
					type="button"
					className="gui-stepper-btn"
					aria-label={t("decrease")}
					disabled={value <= min}
					onClick={() => commit(value - step)}
				>
					<Icon name="subtract" className="h-3 w-3" />
				</button>
				<input
					type="number"
					min={min}
					max={max}
					step={step}
					value={shown}
					className="gui-stepper-input"
					aria-label={label}
					onChange={e => setDraft(e.target.value)}
					onBlur={() => commit(draft ?? value)}
				/>
				<button
					type="button"
					className="gui-stepper-btn"
					aria-label={t("increase")}
					disabled={value >= max}
					onClick={() => commit(value + step)}
				>
					<Icon name="add" className="h-3 w-3" />
				</button>
			</div>
			<span className="gui-settings-stepper-unit">{unit}</span>
			<button
				type="button"
				className="gui-settings-reset"
				title={t("reset")}
				aria-label={t("reset")}
				disabled={value === defaultValue}
				onClick={() => commit(defaultValue)}
			>
				<Icon name="restart" className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

/** Message content rows are stored as JSON block arrays — flatten to text. */
export function hitText(content: string): string {
	try {
		const parsed: unknown = JSON.parse(content);
		if (Array.isArray(parsed)) {
			return parsed
				.map(b => (b && typeof b === "object" && "text" in b ? String((b as { text: string }).text) : ""))
				.filter(Boolean)
				.join("\n");
		}
		if (parsed && typeof parsed === "object" && "text" in parsed) return String((parsed as { text: string }).text);
	} catch {
		// not JSON — raw text
	}
	return content;
}

export interface McpItem {
	id: string;
	name: string;
	displayName: string;
	description?: string;
	kind: string;
	state: "active" | "disabled" | "shadowed";
	source: { provider: string; providerName: string; level: "user" | "project" | "native" };
}

/** One hit from daemon session.search (view-store materialized tables). */
export interface SearchHit {
	sessionId: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}
export interface SearchResult {
	matches: SearchHit[];
	sessions: { sessionId: string; messageCount: number }[];
}
