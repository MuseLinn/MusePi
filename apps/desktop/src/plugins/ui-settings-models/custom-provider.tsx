/**
 * CustomProviderPane — settings model section's custom-provider domain:
 * the custom providers tab, the add/edit dialog (规范弹窗), and the shared
 * CustomProviderForm. Owns the models.add / models.remove / models.listCustom
 * flows; the form owns its draft and endpoint discovery.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	type CustomProviderDraft,
	CustomProviderForm,
	type CustomProviderPayload,
	customProviderDraftFrom,
	emptyCustomProviderDraft,
} from "../../components/CustomProviderForm";
import { DialogFrame } from "../../components/DialogFrame";
import { reportRequestFailure } from "../../lib/report-request-failure";
import type { RpcClient } from "../../lib/rpc";
import { addProviderModels } from "../../lib/rpc-commands";
import { Icon } from "../../vendor/oc-icons";

export interface CustomProvider {
	name: string;
	/** `providers.<id>.label`: the display name; the id stays the identity. */
	label?: string;
	baseUrl?: string;
	models: {
		id: string;
		name?: string;
		api?: string;
		supportsTools?: boolean;
		input?: string[];
		contextWindow?: number;
		maxTokens?: number;
	}[];
}

export function CustomProviderPane({
	custom,
	rpc,
	sessionId,
	onChanged,
	initialAddOpen = false,
}: {
	custom: CustomProvider[];
	rpc: RpcClient | null;
	sessionId: string | null;
	onChanged(): void;
	/** Land with the add dialog already open. The composer's 添加供应商 entry
	 *  jumps into settings to ADD one — openchamber parity: it selects its
	 *  `ADD_PROVIDER_ID` sentinel so the providers page shows the add form
	 *  itself, not just the provider list the user then has to scan for a
	 *  button. Seeded once (pane mounts fresh per settings open). */
	initialAddOpen?: boolean;
}): ReactNode {
	const [addOpen, setAddOpen] = useState(initialAddOpen);
	const [editingProvider, setEditingProvider] = useState<string | null>(null);
	const [draft, setDraft] = useState<CustomProviderDraft>(() => emptyCustomProviderDraft());
	// Each open remounts the form with the draft seeded for that provider, so a
	// reopened dialog never shows the previous session's typing.
	const [formEpoch, setFormEpoch] = useState(0);
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [addedName, setAddedName] = useState<string | null>(null);

	const closeForm = (): void => {
		setAddOpen(false);
		setEditingProvider(null);
		setFormError(null);
	};

	const openCreate = (): void => {
		setDraft(emptyCustomProviderDraft());
		setEditingProvider(null);
		setFormError(null);
		setFormEpoch(epoch => epoch + 1);
		setAddOpen(true);
	};

	const openEdit = async (name: string): Promise<void> => {
		if (!rpc) return;
		try {
			const cfg = await rpc.request<{
				providers?: Record<
					string,
					{
						label?: string;
						baseUrl?: string;
						api?: string;
						models?: CustomProvider["models"];
					}
				>;
			}>("models.listCustom", {});
			setDraft(customProviderDraftFrom(name, cfg?.providers?.[name] ?? {}));
			setEditingProvider(name);
			setFormError(null);
			setFormEpoch(epoch => epoch + 1);
			setAddOpen(true);
		} catch (err) {
			// The editor could not read the provider; opening it empty would let
			// the user save over the real config.
			reportRequestFailure(t("settings.editCustomProvider"), err);
		}
	};

	const submit = async (provider: CustomProviderPayload): Promise<void> => {
		if (!rpc) return;
		setFormBusy(true);
		setFormError(null);
		try {
			await addProviderModels(rpc, provider, sessionId);
			const wasEditing = editingProvider !== null;
			closeForm();
			setAddedName(
				wasEditing
					? `${t("settings.providerSaved")} ${provider.label ?? provider.name}`
					: (provider.label ?? provider.name),
			);
			window.setTimeout(() => setAddedName(null), 2500);
			onChanged();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setFormBusy(false);
		}
	};

	const removeProvider = async (name: string): Promise<void> => {
		if (!rpc) return; // models.remove needs no session either
		try {
			await rpc.request("models.remove", { sessionId, providerName: name });
			onChanged();
		} catch (err) {
			// The provider is still registered; say why it did not go away.
			reportRequestFailure(t("settings.delete"), err);
		}
	};

	return (
		<>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.customProviders")}</div>
				<div className="gui-settings-section-desc">{t("settings.customProvidersHint")}</div>
				{custom.length === 0 ? (
					<div className="text-[13px] text-[var(--color-text-faint)]">{t("settings.noCustomProviders")}</div>
				) : (
					custom.map(provider => (
						<div key={provider.name} className="gui-settings-row">
							<div className="min-w-0 flex-1">
								<div className="gui-settings-row-label">{provider.label ?? provider.name}</div>
								<div className="gui-cpf-summary">
									{provider.label ? <span className="gui-cpf-summary-id">{provider.name}</span> : null}
									<span>{t("settings.providerModelCount", { count: provider.models.length })}</span>
									{provider.baseUrl ? <span className="gui-cpf-summary-url">{provider.baseUrl}</span> : null}
								</div>
							</div>
							<button
								type="button"
								className="gui-btn"
								title={t("settings.editCustomProvider")}
								aria-label={t("settings.editCustomProvider")}
								onClick={() => void openEdit(provider.name)}
							>
								<Icon name="edit-2" className="h-3.5 w-3.5" />
							</button>
							<button
								type="button"
								className="gui-btn"
								aria-label={`${t("settings.delete")} ${provider.label ?? provider.name}`}
								onClick={() => void removeProvider(provider.name)}
							>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
							</button>
						</div>
					))
				)}
				{addedName ? (
					<div className="mt-2 flex items-center gap-2 text-[13px] text-[var(--color-accent)]">
						<Icon name="check" className="h-3.5 w-3.5" />
						<span>{t("settings.providerAdded")}</span>
					</div>
				) : (
					<button type="button" className="gui-connect-add" onClick={openCreate}>
						<Icon name="add-circle" className="h-4 w-4" />
						<span>{t("settings.addCustomProvider")}</span>
					</button>
				)}
			</div>
			<DialogFrame
				open={addOpen}
				onClose={closeForm}
				className="gui-dialog--settings gui-cpf-dialog"
				label={editingProvider ? t("settings.editCustomProvider") : t("settings.addCustomProvider")}
			>
				<div className="gui-dialog-head">
					<div className="text-[14px] font-medium">
						{editingProvider ? t("settings.editCustomProvider") : t("settings.addCustomProvider")}
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--icon"
						aria-label={t("settings.close")}
						onClick={closeForm}
					>
						<Icon name="close" className="h-3.5 w-3.5" />
					</button>
				</div>
				<CustomProviderForm
					key={`${editingProvider ?? "new"}-${formEpoch}`}
					rpc={rpc}
					mode={editingProvider ? "edit" : "create"}
					initial={draft}
					busy={formBusy}
					error={formError}
					submitLabel={editingProvider ? t("settings.saveChanges") : t("settings.addProvider")}
					onSubmit={submit}
					onCancel={closeForm}
				/>
			</DialogFrame>
		</>
	);
}
