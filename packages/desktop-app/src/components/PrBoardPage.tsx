/**
 * PrBoardPage — the main-view surface for the PR/issue center (sidebar
 * 「问题与拉取请求」entry). A full page over the chat column: page header
 * with the back-to-workspace action and a project picker, then the shared
 * PrCenter body. The app keeps the chat surface mounted underneath
 * (display:none), so leaving the page restores the session view without a
 * re-mount.
 *
 * Project semantics: the board keeps its OWN project — the one it was
 * left on (persisted under `musepi-prboard-project`), falling back to the
 * app's current workspace and then the first known project. The picker in
 * the header switches the board's project only; it never changes the
 * workspace the rest of the app shows. With no known project at all the
 * body is a one-line hint, never a spinner — there is no request in
 * flight to wait for.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { PrCenter } from "./pr-center";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** The board's own memory: which workspace it was last left on. */
const BOARD_PROJECT_KEY = "musepi-prboard-project";

/** Known-workspace list (same source the welcome chips and sidebar read —
 *  seeded from session cwds and explicit picks). */
function knownProjects(): string[] {
	try {
		const raw = localStorage.getItem("musepi-gui-projects");
		const list = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string") : [];
	} catch {
		return [];
	}
}

function dirBasename(dir: string): string {
	return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** The resolution chain: the board's own last pick while that project
 *  still exists, else the app's current workspace, else the first known
 *  project. */
function resolveBoardProject(projects: string[]): string | null {
	if (projects.length === 0) return null;
	try {
		const saved = localStorage.getItem(BOARD_PROJECT_KEY);
		if (saved && projects.includes(saved)) return saved;
	} catch {
		// storage unavailable
	}
	try {
		const current = localStorage.getItem("musepi-gui-project");
		if (current && projects.includes(current)) return current;
	} catch {
		// storage unavailable
	}
	return projects[0] ?? null;
}

export function PrBoardPage({ rpc, onBack }: { rpc: RpcClient | null; onBack(): void }): ReactNode {
	const [projects] = useState(knownProjects);
	const [picked, setPicked] = useState(() => resolveBoardProject(knownProjects()));
	const cwd = picked ?? resolveBoardProject(projects);
	const switchProject = (dir: string): void => {
		// Board-local memory only — the app-wide workspace stays untouched:
		// switching the board never moves the rest of the app.
		setPicked(dir);
		try {
			localStorage.setItem(BOARD_PROJECT_KEY, dir);
		} catch {
			// storage unavailable — the pick still lasts for this mount
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			<WorkspacePageHeader
				icon="git-pull-request"
				title={t("pr board")}
				onBack={onBack}
				backLabel={t("settings.backWorkspace")}
				meta={
					projects.length > 0 && cwd ? (
						<details className="gui-prboard-picker">
							<summary title={cwd} aria-label={t("general.tagWorkspace")}>
								<span className="min-w-0 truncate">{dirBasename(cwd)}</span>
								<Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-none" />
							</summary>
							<div className="gui-prboard-picker-menu" role="menu">
								{projects.map(dir => (
									<button
										key={dir}
										type="button"
										role="menuitem"
										className={`gui-prboard-picker-item${dir === cwd ? " gui-prboard-picker-item--active" : ""}`}
										title={dir}
										onClick={event => {
											switchProject(dir);
											event.currentTarget.closest("details")?.removeAttribute("open");
										}}
									>
										<Icon name="folder" className="h-3.5 w-3.5 flex-none" />
										<span className="min-w-0 flex-1 truncate">{dirBasename(dir)}</span>
										{dir === cwd && <Icon name="check" className="h-3.5 w-3.5 flex-none" />}
									</button>
								))}
							</div>
						</details>
					) : undefined
				}
			/>
			<div className="gui-prboard-body min-h-0 flex-1 px-4 pb-4">
				{rpc && cwd ? (
					<PrCenter rpc={rpc} cwd={cwd} />
				) : (
					<div className="gui-prboard-empty">
						<p className="text-[12.5px] leading-relaxed text-[var(--color-text-faint)]">
							{t("general.prBoardEmptyNoProjects")}
						</p>
					</div>
				)}
			</div>
		</div>
	);
}
