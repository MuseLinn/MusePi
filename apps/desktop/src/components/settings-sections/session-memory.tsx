import { pushActionToast, Segmented, type SegmentedOption, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { PASTE_IMAGE_MENTION_KEY } from "../../lib/composer-prefs";
import type { RpcClient } from "../../lib/rpc";
import { PrefToggle } from "./chat";
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

const BUILTIN_GROUPS: SegmentedOption<string>[] = [
	{ value: "session", label: t("general.sessions") },
	{ value: "memory", label: t("settings.memorySettings") },
	{ value: "prompts", label: t("settings.starterPrompts") },
];

const BUILTIN_IDS = new Set(BUILTIN_GROUPS.map(group => group.value));

/** Built-in tab ids, in order (test + host contract). */
export const BUILTIN_TAB_IDS: readonly string[] = BUILTIN_GROUPS.map(group => group.value);

/** One subnav tab contributed through `settings.subnav.session-memory`. An `id`
 *  that names a built-in tab replaces that tab's content (and label when one is
 *  given); any other id appends a tab. */
export interface SettingsSubnavTab {
	id?: string;
	label?: string;
	node: ReactNode;
}

/**
 * Compose the subnav from the built-ins and the contributed tabs: a contributed
 * id equal to a built-in id replaces that tab, anything else appends. Content
 * lookup returns the contribution so the host can fall back to the built-in
 * renderer when a tab has none.
 */
export function resolveSubnavTabs(tabs: readonly SettingsSubnavTab[]): {
	options: SegmentedOption<string>[];
	contentFor(id: string): ReactNode | undefined;
} {
	const overrideFor = (id: string): SettingsSubnavTab | undefined =>
		tabs.find(tab => tab.id === id && tab.node !== undefined);
	const appended = tabs.filter(tab => !tab.id || !BUILTIN_IDS.has(tab.id));
	const options: SegmentedOption<string>[] = [
		...BUILTIN_GROUPS.map(builtin => ({
			value: builtin.value,
			label: overrideFor(builtin.value)?.label ?? builtin.label,
		})),
		...appended.map((tab, index) => ({
			value: tab.id ?? `contributed-${index}`,
			label: tab.label ?? tab.id ?? t("settings.memorySettings"),
		})),
	];
	return {
		options,
		contentFor(id: string): ReactNode | undefined {
			const override = overrideFor(id);
			if (override) return override.node;
			const index = appended.findIndex((tab, i) => (tab.id ?? `contributed-${i}`) === id);
			return index >= 0 ? appended[index]?.node : undefined;
		},
	};
}

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
	tabs = [],
}: {
	rpc: RpcClient | null;
	currentSessionId: string | null;
	/** Extension takeover of the session group (`settings.section` id `sessions`). */
	sessionSlot?: ReactNode;
	/** Extension takeover of the memory group (`settings.section` id `memory`). */
	memorySlot?: ReactNode;
	/** Tabs contributed by plugins; see {@link SettingsSubnavTab}. */
	tabs?: readonly SettingsSubnavTab[];
}): ReactNode {
	const [group, setGroup] = useState<string>("session");
	const { options, contentFor } = resolveSubnavTabs(tabs);
	const contributed = contentFor(group);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.sessionMemory")}</h2>
			<p className="gui-settings-page-desc">{t("settings.sessionMemoryDescription")}</p>
			<div className="gui-settings-subnav">
				<Segmented
					value={group}
					options={options}
					onChange={next => setGroup(next)}
					ariaLabel={t("settings.sessionMemory")}
				/>
			</div>
			{contributed ? (
				contributed
			) : group === "session" ? (
				<>
					{sessionSlot ?? <SessionsSection rpc={rpc} currentSessionId={currentSessionId} />}
					<InputSuggestionRow rpc={rpc} />
					{/* Input-box behaviour lives with the session it composes into: the
					 * standalone 输入框 page held this one row. */}
					<div className="gui-settings-section">
						<PrefToggle
							label={t("settings.pasteImageAutoMention")}
							description={t("settings.pasteImageAutoMentionHint")}
							storageKey={PASTE_IMAGE_MENTION_KEY}
							on
						/>
					</div>
				</>
			) : group === "memory" ? (
				(memorySlot ?? <MemorySection rpc={rpc} />)
			) : (
				<PromptsSection />
			)}
		</>
	);
}
