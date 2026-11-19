import { pushActionToast, t } from "@musepi/client-core";
import { Check, Square } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
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
	/** The same endpoint already has an entry in the user's own catalog. */
	imported: boolean;
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
 * is never written to. The first step picks, the second confirms — moving a
 * credential out of another agent's file is not a one-click accident.
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
	const [step, setStep] = useState<"pick" | "confirm">("pick");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const registry = useExtensionRegistry(rpc);

	/** Live access state per discovered MCP server, from the extension registry. */
	const serverState = useMemo(() => {
		const map = new Map<string, "active" | "disabled" | "shadowed">();
		for (const item of registry?.extensions ?? []) {
			if (item.kind === "mcp") map.set(item.name, item.state);
		}
		return map;
	}, [registry]);

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
		setStep("pick");
		void load();
	}, [open, load]);

	const toggle = (candidate: ImportCandidate): void => {
		if (candidate.imported) return;
		const key = `${candidate.source}:${candidate.name}`;
		setPicked(previous => {
			const next = new Set(previous);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const selectable = (candidates ?? []).filter(candidate => !candidate.imported);
	const allPicked = selectable.length > 0 && selectable.every(c => picked.has(`${c.source}:${c.name}`));
	const toggleAll = (): void => {
		setPicked(allPicked ? new Set() : new Set(selectable.map(c => `${c.source}:${c.name}`)));
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

	const pickedNames = [...picked].map(key => key.split(":").slice(1).join(":"));

	return (
		<DialogFrame
			open={open}
			onClose={onClose}
			label={t("settings.connectorsImportTitle")}
			className="gui-dialog--connector-import"
			morphKey={`${step}:${candidates === null ? "loading" : candidates.length}:${Boolean(error)}`}
		>
			<div className="gui-import-body">
				<div className="gui-import-head">
					<h3 className="gui-settings-page-title">{t("settings.connectorsImportTitle")}</h3>
					<p className="gui-settings-page-desc">
						{step === "pick" ? t("settings.connectorsImportDesc") : t("settings.connectorsImportConfirmDesc")}
					</p>
				</div>

				{error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

				{step === "pick" ? (
					<>
						{candidates === null ? (
							<div className="text-[12px] text-[var(--color-text-muted)]">
								{t("settings.connectorsImportScanning")}
							</div>
						) : candidates.length === 0 ? (
							<div className="text-[12px] text-[var(--color-text-muted)]">
								{t("settings.connectorsImportEmpty")}
							</div>
						) : (
							<>
								<div className="gui-import-toolbar">
									<span className="text-[11.5px] text-[var(--color-text-muted)]">
										{t("settings.connectorsImportPicked", { count: String(picked.size) })}
									</span>
									<button type="button" className="gui-btn-ghost text-[12px]" onClick={toggleAll}>
										{allPicked
											? t("settings.connectorsImportClear")
											: t("settings.connectorsImportSelectAll")}
									</button>
								</div>
								<div className="gui-import-list">
									{candidates.map(candidate => {
										const key = `${candidate.source}:${candidate.name}`;
										const checked = picked.has(key);
										const state = serverState.get(candidate.name);
										return (
											<button
												key={key}
												type="button"
												className={`gui-import-row${checked ? " gui-import-row--on" : ""}`}
												aria-pressed={checked}
												disabled={candidate.imported}
												onClick={() => toggle(candidate)}
											>
												<span className="gui-import-check" aria-hidden="true">
													<MorphIcon icon={checked ? Check : Square} size={14} />
												</span>
												<span className="gui-import-text">
													<span className="gui-import-title">
														<span className="gui-import-name">{candidate.name}</span>
														<span className="gui-provider-chip">{candidate.transport}</span>
														<span className="gui-provider-chip">{candidate.source}</span>
														{state === "active" && (
															<span className="gui-provider-chip gui-provider-chip--ok">
																{t("settings.mcpAvailable")}
															</span>
														)}
														{state === "disabled" && (
															<span className="gui-provider-chip">{t("settings.disabled")}</span>
														)}
														{state === "shadowed" && (
															<span className="gui-provider-chip">
																{t("settings.connectorsImportShadowed")}
															</span>
														)}
														{candidate.secretFields.length > 0 && (
															<span className="gui-provider-chip">
																{t("settings.connectorsImportHasSecret")}
															</span>
														)}
														{candidate.imported && (
															<span className="gui-provider-chip">
																{t("settings.connectorsImportAlready")}
															</span>
														)}
													</span>
													<span className="gui-import-endpoint">
														{candidate.url ?? candidate.command ?? ""}
													</span>
												</span>
											</button>
										);
									})}
								</div>
							</>
						)}

						<div className="gui-import-actions">
							<button type="button" className="gui-btn" onClick={onClose} disabled={busy}>
								{t("settings.cancel")}
							</button>
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								onClick={() => setStep("confirm")}
								disabled={busy || picked.size === 0}
							>
								{t("settings.connectorsImportNext", { count: String(picked.size) })}
							</button>
						</div>
					</>
				) : (
					<>
						<div className="gui-import-summary">
							<div className="text-[12px] font-medium">
								{t("settings.connectorsImportConfirmTitle", { count: String(picked.size) })}
							</div>
							<ul className="gui-import-names">
								{pickedNames.map(name => (
									<li key={name}>{name}</li>
								))}
							</ul>
							<ul className="gui-import-effects">
								<li>{t("settings.connectorsImportEffectCatalog")}</li>
								<li>{t("settings.connectorsImportEffectSecret")}</li>
								<li>{t("settings.connectorsImportEffectDisabled")}</li>
							</ul>
						</div>
						<div className="gui-import-actions">
							<button type="button" className="gui-btn" onClick={() => setStep("pick")} disabled={busy}>
								{t("settings.connectorsImportBack")}
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
					</>
				)}
			</div>
		</DialogFrame>
	);
}
