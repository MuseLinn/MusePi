import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { pickDirectory } from "../../lib/electron";
import type { RpcClient } from "../../lib/rpc";
import { DirectoryListEditor } from "../DirectoryListEditor";
import { SchemaTabSection } from "./schema";

/**
 * Settings → 上下文: the global default roots every new session inherits.
 *
 * Project-level directories are edited in the project dialog; this block is
 * intentionally the only global list so the two scopes do not blur. The
 * schema row for the same key is excluded below to avoid a second editor.
 */
function WorkspaceDirectoriesSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [directories, setDirectories] = useState<string[] | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, unknown>>("settings.get", { keys: ["workspace.additionalDirectories"] })
			.then(values => {
				if (!alive) return;
				const raw = values?.["workspace.additionalDirectories"];
				setDirectories(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []);
			})
			.catch(failure => {
				if (alive) setError(failure instanceof Error ? failure.message : String(failure));
			});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const commit = async (next: string[]): Promise<void> => {
		if (!rpc) return;
		const previous = directories ?? [];
		setDirectories(next);
		setSaving(true);
		setError(null);
		try {
			await rpc.request("settings.set", { key: "workspace.additionalDirectories", value: next });
		} catch (failure) {
			setDirectories(previous);
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="gui-settings-group">
			<div className="gui-settings-group-h">{t("settings.workspaceDirectories")}</div>
			<p className="gui-settings-directories-desc">{t("settings.workspaceDirectoriesDescription")}</p>
			<div className="gui-settings-directories">
				{directories === null ? (
					<p className="gui-directory-empty">{t("settings.loading2")}</p>
				) : (
					<DirectoryListEditor
						directories={directories}
						disabled={saving}
						max={64}
						emptyHint={t("settings.workspaceDirectoriesEmpty")}
						onChange={next => void commit(next)}
						onPick={() => pickDirectory()}
					/>
				)}
				{error && (
					<p className="gui-project-dialog-error" role="alert">
						{error}
					</p>
				)}
			</div>
		</section>
	);
}

/** Settings → 上下文: TUI context-tab parity (general/compaction/
 *  TTSR/experimental groups), schema driven. */
export function ContextSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.context")}</h2>
			<WorkspaceDirectoriesSection rpc={rpc} />
			<SchemaTabSection rpc={rpc} tabs={["context"]} excludeKeys={["workspace.additionalDirectories"]} />
		</>
	);
}
