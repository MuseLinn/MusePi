import { t } from "@musepi/client-core";
import { type ReactNode, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * "开始使用" getting-started card (2026-11-08).
 *
 * Behaviour contract: a compact card docked at the BOTTOM of the second-tier
 * sidebar, with a title + overflow menu + collapse chevron, a thin completion
 * bar, and a short checklist whose rows carry a hollow circle (pending) or a
 * check (done) plus a trailing glyph. Clicking a row opens that entry point;
 * the visited row becomes done and the bar advances. Collapse / dismiss /
 * progress survive a renderer reload.
 *
 * Completion is "visited", read from renderer-local state — no daemon probe
 * and no claim about the user's actual configuration.
 */

export const GETTING_STARTED_STORAGE_KEY = "musepi-gui-getting-started-v1";

export const GETTING_STARTED_STEPS = [
	{ id: "appearance", label: "settings.gettingStartedAppearance" },
	{ id: "provider", label: "settings.gettingStartedProvider" },
	{ id: "import", label: "settings.gettingStartedImport" },
	{ id: "task", label: "settings.gettingStartedTask" },
] as const;

export type GettingStartedStepId = (typeof GETTING_STARTED_STEPS)[number]["id"];

export interface GettingStartedState {
	collapsed: boolean;
	done: string[];
	dismissed: boolean;
}

const INITIAL: GettingStartedState = { collapsed: false, done: [], dismissed: false };

export function readGettingStarted(): GettingStartedState {
	try {
		const raw = localStorage.getItem(GETTING_STARTED_STORAGE_KEY);
		if (!raw) return INITIAL;
		const parsed = JSON.parse(raw) as Partial<GettingStartedState>;
		return {
			collapsed: parsed.collapsed === true,
			done: Array.isArray(parsed.done) ? parsed.done.filter(id => typeof id === "string") : [],
			dismissed: parsed.dismissed === true,
		};
	} catch {
		return INITIAL;
	}
}

export function writeGettingStarted(next: GettingStartedState): void {
	try {
		localStorage.setItem(GETTING_STARTED_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// A blocked storage must not break the sidebar.
	}
}

export function GettingStartedCard({ onAction }: { onAction(id: GettingStartedStepId): void }): ReactNode {
	const [state, setState] = useState<GettingStartedState>(readGettingStarted);
	const [menuOpen, setMenuOpen] = useState(false);

	const update = (patch: Partial<GettingStartedState>): void => {
		setState(previous => {
			const next = { ...previous, ...patch };
			writeGettingStarted(next);
			return next;
		});
	};
	if (state.dismissed) return null;

	const doneCount = GETTING_STARTED_STEPS.filter(step => state.done.includes(step.id)).length;
	const total = GETTING_STARTED_STEPS.length;
	const allDone = doneCount === total;

	return (
		<section className="gui-getting-started" aria-label={t("settings.gettingStarted")}>
			<div className="gui-getting-started-head">
				<button
					type="button"
					className="gui-getting-started-toggle"
					aria-expanded={!state.collapsed}
					aria-label={t(state.collapsed ? "settings.gettingStartedExpand" : "settings.gettingStartedCollapse")}
					onClick={() => update({ collapsed: !state.collapsed })}
				>
					<span className="gui-getting-started-title">{t("settings.gettingStarted")}</span>
					<span className="gui-getting-started-chevron" data-collapsed={state.collapsed ? "true" : undefined} />
				</button>
				<span className="gui-getting-started-count">
					{allDone
						? t("settings.gettingStartedAllDone")
						: `${doneCount}/${total} ${t("settings.gettingStartedDone")}`}
				</span>
				<div className="gui-getting-started-overflow">
					<button
						type="button"
						className="gui-getting-started-more"
						aria-label={t("settings.gettingStartedMore")}
						aria-expanded={menuOpen}
						onClick={() => setMenuOpen(open => !open)}
					>
						⋯
					</button>
					{menuOpen && (
						<div className="gui-getting-started-menu" role="menu">
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									update({ ...INITIAL });
									setMenuOpen(false);
								}}
							>
								{t("settings.gettingStartedReset")}
							</button>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									update({ dismissed: true });
									setMenuOpen(false);
								}}
							>
								{t("settings.gettingStartedHide")}
							</button>
						</div>
					)}
				</div>
			</div>
			<div
				className="gui-getting-started-progress"
				role="progressbar"
				aria-valuenow={doneCount}
				aria-valuemin={0}
				aria-valuemax={total}
			>
				<span style={{ width: `${(doneCount / total) * 100}%` }} />
			</div>
			{/* Kept mounted so collapsing animates instead of snapping. */}
			<ul
				className="gui-getting-started-list"
				data-collapsed={state.collapsed ? "true" : undefined}
				aria-hidden={state.collapsed}
			>
				{GETTING_STARTED_STEPS.map(step => {
					const done = state.done.includes(step.id);
					return (
						<li key={step.id}>
							<button
								type="button"
								className={`gui-getting-started-row${done ? " gui-getting-started-row--done" : ""}`}
								data-step={step.id}
								onClick={() => {
									onAction(step.id);
									if (!done) update({ done: [...state.done, step.id] });
								}}
							>
								<span className="gui-getting-started-check" aria-hidden="true">
									{done ? <Icon name="check" className="h-3 w-3" /> : null}
								</span>
								<span className="gui-getting-started-row-label">{t(step.label)}</span>
								<Icon name="add" className="gui-getting-started-row-glyph h-3 w-3" />
							</button>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
