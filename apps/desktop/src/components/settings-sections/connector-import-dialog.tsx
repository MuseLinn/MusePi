import { pushActionToast, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { DialogFrame } from "../DialogFrame";

/** One server another agent on this machine has configured. */
interface ImportCandidate {
	source: string;
	name: string;
	transport: "http" | "sse" | "stdio";
	url?: string;
	command?: string;
	/** Names of the credential fields, never their values. */
	secretFields: string[];
}

interface ImportResult {
	imported: string[];
	skipped: string[];
}

/**
 * Import MCP servers from the agents already installed here.
 *
 * The list comes from the same discovery layer that loads other agents' MCP
 * servers into a session, so what is offered is exactly what a session could
 * already reach. Importing copies the endpoint into the user's own catalog
 * and moves a plain-text credential into the encrypted store; the source file
 * is never written to.
 */
export function ConnectorImportDialog({
	rpc,
	open,
	onClose,
	onImported,
}: {
	rpc: RpcClient | null;
	open: boolean;
	onClose(): void;
	onImported(): void;
}): ReactNode {
	const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const result = await rpc.request<{ candidates?: ImportCandidate[] }>("connectors.import.scan", {});
			setCandidates(Array.isArray(result?.candidates) ? result.candidates : []);
		} catch (scanError) {
			setError(scanError instanceof Error ? scanError.message : String(scanError));
			setCandidates([]);
		}
	}, [rpc]);

	useEffect(() => {
		if (!open) return;
		setError(null);
		setPicked(new Set());
		void load();
	}, [open, load]);

	const toggle = (candidate: ImportCandidate): void => {
		const key = `${candidate.source}:${candidate.name}`;
		setPicked(previous => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const apply = async (): Promise<void> => {
		if (!rpc || picked.size === 0) return;
		setBusy(true);
		setError(null);
		try {
			const items = [...picked].map(key => {
				const [source, name] = key.split(":");
				return { source, name };
			});
			const result = await rpc.request<ImportResult>("connectors.import.apply", { items });
			const imported = result?.imported?.length ?? 0;
			const skipped = result?.skipped?.length ?? 0;
			pushActionToast({
				kind: skipped > 0 ? "warning" : "success",
				message: t("settings.connectorsImported", { count: String(imported) }),
				...(skipped > 0 ? { details: t("settings.connectorsImportSkipped", { count: String(skipped) }) } : {}),
				dedupeKey: "connector:import",
			});
			onImported();
			onClose();
		} catch (applyError) {
			setError(applyError instanceof Error ? applyError.message : String(applyError));
		} finally {
			setBusy(false);
		}
	};

	return (
		<DialogFrame open={open} onClose={onClose} label={t("settings.connectorsImportTitle")} className="gui-dialog">
			<div className="flex flex-col gap-3 p-4">
				<div>
					<h3 className="gui-settings-page-title">{t("settings.connectorsImportTitle")}</h3>
					<p className="gui-settings-page-desc">{t("settings.connectorsImportDesc")}</p>
				</div>

				{error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

				{candidates === null ? (
					<div className="text-[12px] text-[var(--color-text-muted)]">
						{t("settings.connectorsImportScanning")}
					</div>
				) : candidates.length === 0 ? (
					<div className="text-[12px] text-[var(--color-text-muted)]">{t("settings.connectorsImportEmpty")}</div>
				) : (
					<div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
						{candidates.map(candidate => {
							const key = `${candidate.source}:${candidate.name}`;
							const checked = picked.has(key);
							return (
								<label key={key} className="gui-agent-card flex cursor-pointer items-center gap-3">
									<input
										type="checkbox"
										checked={checked}
										onChange={() => toggle(candidate)}
										aria-label={candidate.name}
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-medium">{candidate.name}</div>
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">
											{candidate.source} · {candidate.url ?? candidate.command}
										</div>
									</div>
									{candidate.secretFields.length > 0 && (
										<span className="gui-provider-chip">{t("settings.connectorsImportHasSecret")}</span>
									)}
								</label>
							);
						})}
					</div>
				)}

				<div className="flex items-center justify-end gap-2">
					<button type="button" className="gui-btn" onClick={onClose} disabled={busy}>
						{t("settings.cancel")}
					</button>
					<button
						type="button"
						className="gui-btn gui-btn-primary"
						onClick={() => void apply()}
						disabled={busy || picked.size === 0}
					>
						{t("settings.connectorsImportApply")}
					</button>
				</div>
			</div>
		</DialogFrame>
	);
}
