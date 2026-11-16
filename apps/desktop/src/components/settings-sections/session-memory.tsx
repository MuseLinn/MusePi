import { pushActionToast, Segmented, type SegmentedOption, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { MemorySection } from "./memory";
import { SessionsSection } from "./sessions";
import { PromptsSection } from "./suggestions";

/**
 * 会话与记忆 — one page for everything that outlives a single message: how a
 * turn behaves, what the composer offers before the next one, and what the
 * agent remembers afterwards.
 *
 * The three groups used to be separate nav rows (`sessions`, `memory`,
 * `suggestions`), which read as unrelated features even though they answer one
 * question. They now share one page and one sub-navigation: session behaviour
 * and the input candidate are short enough to sit together, while memory —
 * which carries a backend, counters and maintenance actions — keeps its own
 * pane instead of stretching the page into a wall of rows.
 */

type MemoryGroup = "session" | "memory" | "prompts";

const GROUPS: SegmentedOption<MemoryGroup>[] = [
	{ value: "session", label: t("general.sessions") },
	{ value: "memory", label: t("settings.memorySettings") },
	{ value: "prompts", label: t("settings.starterPrompts") },
];

/** Daemon setting that gates next-input prediction. Unknown reads fall back to
 *  the schema default (on) — the same fallback the daemon applies. */
const SUGGESTION_KEY = "suggestion.enabled";

function InputSuggestionRow({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [enabled, setEnabled] = useState<boolean | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, unknown>>("settings.get", { keys: [SUGGESTION_KEY] })
			.then(res => {
				if (alive) setEnabled(res?.[SUGGESTION_KEY] !== false);
			})
			.catch(() => {
				if (alive) setEnabled(true);
			});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const toggle = useCallback((): void => {
		if (enabled === null) return;
		const next = !enabled;
		setEnabled(next);
		void rpc?.request("settings.set", { key: SUGGESTION_KEY, value: next }).catch(error => {
			setEnabled(!next);
			pushActionToast({
				kind: "error",
				message: t("settings.inputSuggestionsSaveFailed"),
				details: error instanceof Error ? error.message : String(error),
			});
		});
	}, [enabled, rpc]);

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("settings.inputSuggestions")}</div>
					<div className="gui-settings-row-desc">{t("settings.inputSuggestionsDescription")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={enabled === true}
					aria-label={t("settings.inputSuggestions")}
					className={`gui-toggle${enabled === true ? " gui-toggle--on" : ""}`}
					disabled={enabled === null}
					onClick={toggle}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
		</div>
	);
}

export function SessionMemorySection({
	rpc,
	currentSessionId,
	sessionSlot,
	memorySlot,
}: {
	rpc: RpcClient | null;
	currentSessionId: string | null;
	/** Extension takeover of the session group (`settings.tab.sessions`). */
	sessionSlot?: ReactNode;
	/** Extension takeover of the memory group (`settings.tab.memory`). */
	memorySlot?: ReactNode;
}): ReactNode {
	const [group, setGroup] = useState<MemoryGroup>("session");
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.sessionMemory")}</h2>
			<p className="gui-settings-page-desc">{t("settings.sessionMemoryDescription")}</p>
			<div className="gui-settings-subnav">
				<Segmented
					value={group}
					options={GROUPS}
					onChange={next => setGroup(next)}
					ariaLabel={t("settings.sessionMemory")}
				/>
			</div>
			{group === "session" ? (
				<>
					{sessionSlot ?? <SessionsSection rpc={rpc} currentSessionId={currentSessionId} />}
					<InputSuggestionRow rpc={rpc} />
				</>
			) : group === "memory" ? (
				(memorySlot ?? <MemorySection rpc={rpc} />)
			) : (
				<PromptsSection />
			)}
		</>
	);
}
