import { ChevronDown, CircleAlert, FolderGit2, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type { SessionClient } from "../../lib/client";
import { FilePanel } from "./FilePanel";

/**
 * Workspace panel (design frame 「工作区五标签」): one entry, five tabs —
 * changes / files / terminal / notes / MCP. Changes + files are live over the
 * existing RPCs (daemon `git.status`/`git.diff`/fs.*); terminal / notes / MCP
 * need host data channels that don't exist yet, so they render greyed and
 * inert rather than as fake tabs (design rule: no pretend controls).
 *
 * The `files` tab simply embeds the previous FilePanel so nothing regresses.
 * Git RPCs are daemon-transport only — a collab-direct guest gets a guide
 * state instead of a spinner that can never finish.
 */

type WorkspaceTab = "changes" | "files" | "terminal" | "notes" | "mcp";

const TABS: ReadonlyArray<{ id: WorkspaceTab; label: string; disabled?: boolean }> = [
	{ id: "changes", label: t("changes") },
	{ id: "files", label: t("files") },
	{ id: "terminal", label: t("terminal"), disabled: true },
	{ id: "notes", label: t("notes"), disabled: true },
	{ id: "mcp", label: t("mcp"), disabled: true },
];

interface GitStatusFile {
	path: string;
	status: string;
}

interface GitStatus {
	root?: string;
	branch?: string | null;
	ahead?: number;
	behind?: number;
	staged?: GitStatusFile[];
	unstaged?: GitStatusFile[];
	untracked?: GitStatusFile[];
	added?: number;
	deleted?: number;
	error?: string;
}

interface GitDiff {
	staged?: string;
	unstaged?: string;
	error?: string;
}

export function WorkspacePanel({
	client,
	cwd,
	readOnly,
}: {
	client: SessionClient;
	cwd: string | null;
	readOnly: boolean;
}): ReactNode {
	const [tab, setTab] = useState<WorkspaceTab>("changes");
	return (
		<div className="sh-wspanel">
			<div className="sh-wspanel-tabs" role="tablist" aria-label={t("workspace")}>
				{TABS.map(item =>
					item.disabled ? (
						<span key={item.id} className="sh-wspanel-tab sh-wspanel-tab--off" aria-disabled>
							{item.label}
						</span>
					) : (
						<button
							key={item.id}
							type="button"
							role="tab"
							aria-selected={tab === item.id}
							className={`sh-wspanel-tab${tab === item.id ? " sh-wspanel-tab--on" : ""}`}
							onClick={() => setTab(item.id)}
						>
							{item.label}
						</button>
					),
				)}
			</div>
			<div className="sh-wspanel-body">
				{tab === "changes" && <ChangesTab client={client} cwd={cwd} />}
				{tab === "files" && <FilePanel client={client} cwd={cwd} readOnly={readOnly} />}
				{tab === "terminal" && <DisabledTab label={t("terminal")} />}
				{tab === "notes" && <DisabledTab label={t("notes")} />}
				{tab === "mcp" && <DisabledTab label={t("mcp")} />}
			</div>
		</div>
	);
}

/** Working-tree changes: git.status list + per-file diff preview on tap. */
function ChangesTab({ client, cwd }: { client: SessionClient; cwd: string | null }): ReactNode {
	const [state, setState] = useState<GitStatus | null>(null);
	const [failed, setFailed] = useState(false);
	const [loading, setLoading] = useState(true);
	const [openPath, setOpenPath] = useState<string | null>(null);
	const [diff, setDiff] = useState<string | null>(null);
	const [diffErr, setDiffErr] = useState(false);

	const load = useCallback((): void => {
		setLoading(true);
		setFailed(false);
		client
			.rpc<GitStatus>("git.status", { cwd, numstat: true })
			.then(res => {
				setState(res?.error ? null : res);
				if (!res || res.error) setFailed(true);
			})
			.catch(() => {
				// collab-direct transport has no git.* — guide, don't hang
				setFailed(true);
				setState(null);
			})
			.finally(() => setLoading(false));
	}, [client, cwd]);

	useEffect(() => {
		load();
	}, [load]);

	const toggleFile = (path: string): void => {
		if (openPath === path) {
			setOpenPath(null);
			setDiff(null);
			return;
		}
		setOpenPath(path);
		setDiff(null);
		setDiffErr(false);
		client
			.rpc<GitDiff>("git.diff", { cwd, path })
			.then(res => {
				const text = [res.staged, res.unstaged].filter(Boolean).join("\n").trim();
				setDiff(text.length > 0 ? text : null);
				if (!text) setDiffErr(true);
			})
			.catch(() => setDiffErr(true));
	};

	if (failed) {
		return (
			<div className="sh-wspanel-guide">
				<FolderGit2 size={22} aria-hidden />
				<p>{t("diff unavailable")}</p>
				<p className="sh-wspanel-guide-sub">{t("needs host channel")}</p>
			</div>
		);
	}

	const groups: { title: string; rows: GitStatusFile[] }[] = [
		{ title: t("staged"), rows: state?.staged ?? [] },
		{ title: t("unstaged"), rows: state?.unstaged ?? [] },
		{ title: t("untracked"), rows: state?.untracked ?? [] },
	];
	const total = groups.reduce((n, g) => n + g.rows.length, 0);

	return (
		<div className="sh-changes">
			<div className="sh-changes-head">
				<span className="sh-changes-branch">{state?.branch ?? "…"}</span>
				{typeof state?.added === "number" && (
					<span className="sh-changes-numstat">
						<span className="sh-diff-add">+{state.added}</span>
						<span className="sh-diff-del">−{state.deleted ?? 0}</span>
					</span>
				)}
				<button type="button" className="sh-changes-reload" onClick={load} title={t("refresh")}>
					<RefreshCw size={13} className={loading ? "sh-ws-spin" : undefined} />
				</button>
			</div>
			{!loading && total === 0 && <p className="sh-changes-empty">{t("no pending changes")}</p>}
			{groups.map(
				group =>
					group.rows.length > 0 && (
						<div key={group.title} className="sh-changes-group">
							<p className="sh-changes-group-title">{group.title}</p>
							{group.rows.map(row => (
								<div key={`${group.title}:${row.path}`} className="sh-changes-item">
									<button
										type="button"
										className="sh-changes-file"
										onClick={() => toggleFile(row.path)}
										aria-expanded={openPath === row.path}
									>
										<span className={`sh-changes-x sh-changes-x--${row.status[0] ?? "m"}`}>{row.status}</span>
										<span className="sh-changes-path">{row.path}</span>
										<ChevronDown
											size={13}
											className={`tr-chev${openPath === row.path ? " tr-chev--open" : ""}`}
											aria-hidden
										/>
									</button>
									{openPath === row.path &&
										(diffErr ? (
											<p className="sh-changes-differr">{t("diff unavailable")}</p>
										) : diff === null ? (
											<p className="sh-changes-differr">…</p>
										) : (
											<pre className="sh-changes-diff">{diff}</pre>
										))}
								</div>
							))}
						</div>
					),
			)}
		</div>
	);
}

/** Placeholder for tabs that need a host data channel that doesn't exist yet. */
function DisabledTab({ label }: { label: string }): ReactNode {
	return (
		<div className="sh-wspanel-guide sh-wspanel-guide--off">
			<CircleAlert size={20} aria-hidden />
			<p>{label}</p>
			<p className="sh-wspanel-guide-sub">{t("needs host channel")}</p>
		</div>
	);
}
