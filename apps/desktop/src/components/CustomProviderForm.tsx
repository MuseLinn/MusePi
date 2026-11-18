/**
 * The one add/edit form for a `models.yml` provider. The settings
 * custom-provider dialog and onboarding's guide both render it; it owns the
 * draft, endpoint discovery, row expansion and validation, while the caller
 * owns the RPC and the surrounding dialog or card.
 *
 * The model list is one list: discovered rows and hand-typed rows are the same
 * draft shape, so a capability override edits in place instead of living in a
 * second "hand row" form.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { GuiSelect } from "./GuiSelect";
import { EndpointCandidatesDialog, QuickProviderChips, URL_HINTS, useEndpointModels } from "./provider-setup-shared";

export const PROVIDER_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

export interface CustomProviderModelDraft {
	/** Stable row key for expansion; the model id may still be empty. */
	row: string;
	id: string;
	name?: string;
	/** Model-level protocol override; null deletes the stored override. */
	api?: string | null;
	supportsTools?: boolean | null;
	/** Input modalities; null deletes the stored override. */
	input?: string[] | null;
	contextWindow?: number | null;
	maxTokens?: number | null;
	compactionModel?: string;
}

export interface CustomProviderDraft {
	label: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	models: CustomProviderModelDraft[];
}

/** One model row as `models.add` takes it (null deletes an override). */
export interface CustomProviderModelPayload {
	id: string;
	name?: string;
	api?: string | null;
	supportsTools?: boolean | null;
	input?: string[] | null;
	contextWindow?: number | null;
	maxTokens?: number | null;
	compactionModel?: string;
}

/** The provider block `models.add` writes. */
export interface CustomProviderPayload {
	name: string;
	/** Display name; null removes one an earlier save wrote. */
	label: string | null;
	baseUrl: string;
	apiKey?: string;
	api?: string;
	models: CustomProviderModelPayload[];
}

let rowSeq = 0;
const nextRow = (): string => `model-${++rowSeq}`;

export function emptyCustomProviderDraft(): CustomProviderDraft {
	return { label: "", name: "", baseUrl: "", apiKey: "", api: "openai-completions", models: [] };
}

/** Build a draft from a `models.listCustom` provider row (edit mode). */
export function customProviderDraftFrom(
	name: string,
	row: {
		label?: string;
		baseUrl?: string;
		api?: string;
		models?: {
			id: string;
			name?: string;
			api?: string;
			supportsTools?: boolean;
			input?: string[];
			contextWindow?: number;
			maxTokens?: number;
			compactionModel?: string;
		}[];
	},
): CustomProviderDraft {
	return {
		label: row.label ?? "",
		name,
		baseUrl: row.baseUrl ?? "",
		apiKey: "",
		api: row.api ?? "openai-completions",
		models: (row.models ?? []).map(model => ({
			row: nextRow(),
			id: model.id ?? "",
			...(model.name ? { name: model.name } : {}),
			...(model.api ? { api: model.api } : {}),
			...(model.supportsTools !== undefined ? { supportsTools: model.supportsTools } : {}),
			...(model.input && model.input.length > 0 ? { input: model.input } : {}),
			...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
			...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
			...(model.compactionModel ? { compactionModel: model.compactionModel } : {}),
		})),
	};
}

export interface CustomProviderFormProps {
	rpc: RpcClient | null;
	mode: "create" | "edit";
	/** Seeded once; rerender with a new `key` to switch provider. */
	initial: CustomProviderDraft;
	busy?: boolean;
	/** A failure the caller's RPC returned, shown above the actions. */
	error?: string | null;
	submitLabel: string;
	onSubmit(provider: CustomProviderPayload): void | Promise<void>;
	onCancel?(): void;
	/** Extra buttons in the action row, given the live draft (onboarding's
	 *  connection test reads the endpoint before anything is saved). */
	renderActions?(draft: CustomProviderDraft): ReactNode;
}

function apiLabel(api: string): string {
	switch (api) {
		case "openai-responses":
			return t("settings.protocolResponses");
		case "anthropic-messages":
			return t("settings.protocolAnthropicMessages");
		case "google-generative-ai":
			return t("settings.protocolGoogle");
		default:
			return t("settings.protocolChatCompletions");
	}
}

function modalitiesOf(model: CustomProviderModelDraft): string[] {
	return model.input ?? [];
}

function modelPayload(model: CustomProviderModelDraft): CustomProviderModelPayload {
	const payload: CustomProviderModelPayload = { id: model.id.trim() };
	if (model.name?.trim()) payload.name = model.name.trim();
	if (model.api === null) payload.api = null;
	else if (model.api) payload.api = model.api;
	if (model.supportsTools === null) payload.supportsTools = null;
	else if (model.supportsTools !== undefined) payload.supportsTools = model.supportsTools;
	if (model.input === null) payload.input = null;
	else if (Array.isArray(model.input)) payload.input = model.input.length > 0 ? model.input : null;
	if (model.contextWindow === null) payload.contextWindow = null;
	else if (model.contextWindow !== undefined) payload.contextWindow = model.contextWindow;
	if (model.maxTokens === null) payload.maxTokens = null;
	else if (model.maxTokens !== undefined) payload.maxTokens = model.maxTokens;
	if (model.compactionModel?.trim()) payload.compactionModel = model.compactionModel.trim();
	return payload;
}

export function CustomProviderForm({
	rpc,
	mode,
	initial,
	busy = false,
	error = null,
	submitLabel,
	onSubmit,
	onCancel,
	renderActions,
}: CustomProviderFormProps): ReactNode {
	const [draft, setDraft] = useState<CustomProviderDraft>(initial);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [submitting, setSubmitting] = useState(false);
	// Rows the endpoint no longer returns, checked for removal when the
	// fetched list opens (unchecking keeps a private alias).
	const [pickedStale, setPickedStale] = useState<ReadonlySet<string>>(new Set());
	const [showApiKey, setShowApiKey] = useState(false);
	const [invalid, setInvalid] = useState<{ name?: boolean; baseUrl?: boolean; models?: boolean; message?: string }>(
		{},
	);
	const ep = useEndpointModels(rpc, {
		name: draft.name,
		baseUrl: draft.baseUrl,
		apiKey: draft.apiKey,
		api: draft.api,
	});

	const setField = <K extends keyof Omit<CustomProviderDraft, "models">>(
		key: K,
		value: CustomProviderDraft[K],
	): void => {
		setDraft(current => ({ ...current, [key]: value }));
		setInvalid(current => ({ ...current, [key]: false, message: undefined }));
	};

	const patchModel = (row: string, patch: Partial<CustomProviderModelDraft>): void => {
		setDraft(current => ({
			...current,
			models: current.models.map(model => (model.row === row ? { ...model, ...patch } : model)),
		}));
		setInvalid(current => ({ ...current, models: false, message: undefined }));
	};

	const addModel = (): void => {
		const row = nextRow();
		setDraft(current => ({ ...current, models: [...current.models, { row, id: "" }] }));
		setExpanded(current => new Set([...current, row]));
	};

	const removeModel = (row: string): void => {
		setDraft(current => ({ ...current, models: current.models.filter(model => model.row !== row) }));
		setExpanded(current => {
			const next = new Set(current);
			next.delete(row);
			return next;
		});
	};

	const toggleModel = (row: string): void => {
		setExpanded(current => {
			const next = new Set(current);
			if (next.has(row)) next.delete(row);
			else next.add(row);
			return next;
		});
	};

	// Fetched candidates vs the draft: rows already listed, and rows the
	// endpoint dropped (checked for removal by default; uncheck to keep).
	const listedIds = new Set(draft.models.map(model => model.id.trim()).filter(Boolean));
	const candidates = ep.candidates;
	const staleRows =
		candidates === null
			? []
			: draft.models
					.filter(model => {
						const id = model.id.trim();
						return id !== "" && !candidates.some(candidate => candidate.id === id);
					})
					.map(model => ({ id: model.id.trim(), ...(model.name ? { name: model.name } : {}) }));
	const allStaleSelected = staleRows.length > 0 && staleRows.every(model => pickedStale.has(model.id));

	useEffect(() => {
		if (!candidates) {
			setPickedStale(new Set());
			return;
		}
		// A fetch reconciles the list: what the endpoint no longer returns is
		// removed unless the user unticks it. The draft is read once when the
		// result arrives; the modal blocks edits while it is open.
		const returned = new Set(candidates.map(candidate => candidate.id));
		const dropped = draft.models.map(model => model.id.trim()).filter(id => id !== "" && !returned.has(id));
		setPickedStale(new Set(dropped));
	}, [candidates]);

	const applyFetched = (): void => {
		const additions = ep.pickedNew(draft.models.map(model => model.id.trim()).filter(Boolean));
		// The endpoint's name fills a row that has none; a name the user typed
		// is theirs and stays.
		const fetchedNames = new Map((candidates ?? []).map(model => [model.id, model.name] as const));
		setDraft(current => ({
			...current,
			models: [
				...current.models
					.filter(model => {
						const id = model.id.trim();
						return !(id !== "" && pickedStale.has(id));
					})
					.map(model => {
						const fetched = fetchedNames.get(model.id.trim());
						return !model.name && fetched ? { ...model, name: fetched } : model;
					}),
				...additions.map(model => ({
					row: nextRow(),
					id: model.id,
					...(model.name ? { name: model.name } : {}),
				})),
			],
		}));
		closeFetched();
	};

	const closeFetched = (): void => {
		ep.closePicker();
		setPickedStale(new Set());
	};

	const toggleStale = (id: string): void => {
		setPickedStale(current => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleAllStale = (): void => {
		setPickedStale(allStaleSelected ? new Set() : new Set(staleRows.map(model => model.id)));
	};

	const toggleModality = (model: CustomProviderModelDraft, modality: string): void => {
		const current = modalitiesOf(model);
		patchModel(model.row, {
			input: current.includes(modality) ? current.filter(item => item !== modality) : [...current, modality],
		});
	};

	const submit = async (): Promise<void> => {
		if (submitting || busy) return;
		const named = draft.models.filter(model => model.id.trim());
		const problems: typeof invalid = {};
		if (!draft.name.trim()) problems.name = true;
		if (!draft.baseUrl.trim()) problems.baseUrl = true;
		if (named.length === 0) problems.models = true;
		if (problems.name || problems.baseUrl || problems.models) {
			problems.message = t("settings.providerNameBase.info2");
			setInvalid(problems);
			// A collapsed row would hide its own problem; open every empty row.
			const emptyRows = draft.models.filter(model => !model.id.trim()).map(model => model.row);
			if (emptyRows.length > 0) setExpanded(current => new Set([...current, ...emptyRows]));
			return;
		}
		setSubmitting(true);
		try {
			await onSubmit({
				name: draft.name.trim(),
				label: draft.label.trim() ? draft.label.trim() : null,
				baseUrl: draft.baseUrl.trim(),
				...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
				...(draft.api !== "openai-completions" ? { api: draft.api } : {}),
				models: named.map(modelPayload),
			});
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="gui-cpf">
			<div className="gui-cpf-group">
				<div className="gui-cpf-group-title">{t("settings.providerConnection")}</div>
				<QuickProviderChips onPick={(name, baseUrl) => setDraft(current => ({ ...current, name, baseUrl }))} />
				<label className="gui-cpf-field">
					<span className="gui-cpf-label">{t("settings.providerLabel")}</span>
					<input
						className="gui-input"
						aria-label={t("settings.providerLabel")}
						value={draft.label}
						placeholder={t("settings.providerLabelPlaceholder")}
						disabled={busy || submitting}
						onChange={event => setField("label", event.target.value)}
					/>
					<span className="gui-cpf-help">{t("settings.providerLabelHint")}</span>
				</label>
				<label className="gui-cpf-field">
					<span className="gui-cpf-label">{t("settings.providerName")}</span>
					<input
						className="gui-input"
						aria-label={t("settings.providerName")}
						value={draft.name}
						aria-invalid={invalid.name || undefined}
						disabled={mode === "edit" || busy || submitting}
						onChange={event => setField("name", event.target.value)}
					/>
				</label>
				<label className="gui-cpf-field">
					<span className="gui-cpf-label">{t("settings.providerProtocol")}</span>
					<GuiSelect
						className="gui-input"
						value={draft.api}
						ariaLabel={t("settings.providerProtocol")}
						disabled={busy || submitting}
						onChange={api => setField("api", api)}
						options={PROVIDER_APIS.map(api => ({ value: api, label: apiLabel(api) }))}
					/>
				</label>
				<label className="gui-cpf-field">
					<span className="gui-cpf-label">{t("settings.providerBaseUrl")}</span>
					<input
						className="gui-input"
						aria-label={t("settings.providerBaseUrl")}
						value={draft.baseUrl}
						aria-invalid={invalid.baseUrl || undefined}
						placeholder={URL_HINTS[draft.api] ?? t("settings.providerBaseUrlPlaceholder")}
						disabled={busy || submitting}
						onChange={event => setField("baseUrl", event.target.value)}
					/>
				</label>
				<label className="gui-cpf-field">
					<span className="gui-cpf-label">{t("settings.apiKey")}</span>
					<div className="gui-cpf-secret">
						<input
							className="gui-input"
							aria-label={t("settings.apiKey")}
							type={showApiKey ? "text" : "password"}
							value={draft.apiKey}
							placeholder={mode === "edit" ? t("settings.apiKeyKeepHint") : undefined}
							disabled={busy || submitting}
							onChange={event => setField("apiKey", event.target.value)}
						/>
						<button
							type="button"
							className="gui-btn"
							disabled={busy || submitting}
							onClick={() => setShowApiKey(shown => !shown)}
						>
							{showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}
						</button>
					</div>
				</label>
			</div>

			<div className="gui-cpf-group">
				<div className="gui-cpf-models-head">
					<div className="min-w-0">
						<div className="gui-cpf-group-title">
							{t("settings.providerModels")}
							{draft.models.length > 0 ? ` · ${draft.models.length}` : ""}
						</div>
						<div className="gui-cpf-help">{t("settings.providerModelsHint")}</div>
					</div>
					<div className="gui-cpf-models-actions">
						<button
							type="button"
							className="gui-btn"
							disabled={!draft.baseUrl || ep.fetchingModels || busy || submitting}
							title={draft.baseUrl ? undefined : t("settings.enterBaseUrlFetch")}
							onClick={() => void ep.fetchModels()}
						>
							{ep.fetchingModels ? t("settings.fetchingModels") : t("settings.fetchAvailableModels")}
						</button>
						<button type="button" className="gui-btn" disabled={busy || submitting} onClick={addModel}>
							<Icon name="add-circle" className="h-3.5 w-3.5" />
							{t("settings.addModel")}
						</button>
					</div>
				</div>
				{ep.fetchError ? <div className="gui-cpf-error">{ep.fetchError}</div> : null}
				{draft.models.length === 0 ? (
					<div className="gui-cpf-empty">{t("settings.noProviderModels")}</div>
				) : (
					<div className="gui-cpf-models">
						{draft.models.map(model => {
							const open = expanded.has(model.row);
							const missing = invalid.models && !model.id.trim();
							return (
								<div key={model.row} className="gui-cpf-model" data-open={open || undefined}>
									<div className="gui-cpf-model-head">
										<button
											type="button"
											className="gui-cpf-model-toggle"
											aria-expanded={open}
											onClick={() => toggleModel(model.row)}
										>
											<Icon name={open ? "arrow-down-s" : "arrow-right-s"} className="h-3.5 w-3.5" />
											<span className="gui-cpf-model-id" data-invalid={missing || undefined}>
												{model.id.trim() || t("settings.modelNewRow")}
											</span>
											{model.name ? <span className="gui-cpf-model-name">{model.name}</span> : null}
										</button>
										<button
											type="button"
											className="gui-btn gui-btn--icon"
											aria-label={`${t("settings.delete")} ${model.id || t("settings.modelNewRow")}`}
											disabled={busy || submitting}
											onClick={() => removeModel(model.row)}
										>
											<Icon name="delete-bin" className="h-3.5 w-3.5" />
										</button>
									</div>
									{open ? (
										<div className="gui-cpf-model-body">
											<div className="gui-cpf-row">
												<label className="gui-cpf-field">
													<span className="gui-cpf-label">{t("settings.modelId")}</span>
													<input
														className="gui-input"
														aria-label={t("settings.modelId")}
														value={model.id}
														aria-invalid={missing || undefined}
														disabled={busy || submitting}
														onChange={event => patchModel(model.row, { id: event.target.value })}
													/>
												</label>
												<label className="gui-cpf-field">
													<span className="gui-cpf-label">{t("settings.modelName")}</span>
													<input
														className="gui-input"
														aria-label={t("settings.modelName")}
														value={model.name ?? ""}
														disabled={busy || submitting}
														onChange={event =>
															patchModel(model.row, { name: event.target.value || undefined })
														}
													/>
												</label>
											</div>
											<div className="gui-cpf-caps">
												<div className="gui-cpf-caps-head">
													<span className="gui-cpf-label">{t("settings.modelCapabilities")}</span>
													<button
														type="button"
														className="gui-cpf-link"
														title={t("settings.restoreCapabilitiesAuto")}
														disabled={busy || submitting}
														onClick={() =>
															patchModel(model.row, {
																input: null,
																contextWindow: null,
																maxTokens: null,
																api: null,
																supportsTools: null,
															})
														}
													>
														{t("settings.restoreAuto")}
													</button>
												</div>
												<div className="gui-cpf-checks">
													{(["text", "image", "video"] as const).map(modality => (
														<label key={modality} className="gui-cpf-check">
															<input
																type="checkbox"
																checked={modalitiesOf(model).includes(modality)}
																disabled={busy || submitting}
																onChange={() => toggleModality(model, modality)}
															/>
															{modality}
														</label>
													))}
													<label className="gui-cpf-check">
														<input
															type="checkbox"
															checked={model.supportsTools !== false}
															disabled={busy || submitting}
															onChange={() =>
																patchModel(model.row, {
																	supportsTools: model.supportsTools === false ? null : false,
																})
															}
														/>
														{t("general.modelSupportsTools")}
													</label>
												</div>
												<label className="gui-cpf-field">
													<span className="gui-cpf-label">{t("settings.providerProtocol")}</span>
													<GuiSelect
														className="gui-input"
														value={model.api ?? ""}
														ariaLabel={t("settings.providerProtocol")}
														disabled={busy || submitting}
														onChange={api => patchModel(model.row, { api: api === "" ? null : api })}
														options={[
															{ value: "", label: t("settings.protocolInherit") },
															...PROVIDER_APIS.map(api => ({ value: api, label: apiLabel(api) })),
														]}
													/>
												</label>
												<div className="gui-cpf-row">
													<label className="gui-cpf-field">
														<span className="gui-cpf-label">{t("settings.contextWindow")}</span>
														<input
															className="gui-input"
															type="number"
															min={0}
															value={model.contextWindow ?? ""}
															disabled={busy || submitting}
															onChange={event =>
																patchModel(model.row, {
																	contextWindow: event.target.value
																		? Number(event.target.value)
																		: null,
																})
															}
														/>
													</label>
													<label className="gui-cpf-field">
														<span className="gui-cpf-label">{t("settings.maxOutputTokens")}</span>
														<input
															className="gui-input"
															type="number"
															min={0}
															value={model.maxTokens ?? ""}
															disabled={busy || submitting}
															onChange={event =>
																patchModel(model.row, {
																	maxTokens: event.target.value ? Number(event.target.value) : null,
																})
															}
														/>
													</label>
												</div>
												<label className="gui-cpf-field">
													<span className="gui-cpf-label">{t("settings.compactionModelId")}</span>
													<input
														className="gui-input"
														value={model.compactionModel ?? ""}
														disabled={busy || submitting}
														onChange={event =>
															patchModel(model.row, {
																compactionModel: event.target.value || undefined,
															})
														}
													/>
												</label>
											</div>
										</div>
									) : null}
								</div>
							);
						})}
					</div>
				)}
			</div>

			{invalid.message || error ? <div className="gui-cpf-error">{invalid.message ?? error}</div> : null}

			<div className="gui-cpf-actions">
				{renderActions?.(draft)}
				{onCancel ? (
					<button type="button" className="gui-btn" disabled={busy || submitting} onClick={onCancel}>
						{t("settings.cancel")}
					</button>
				) : null}
				<button
					type="button"
					className="gui-btn gui-btn-approve"
					disabled={busy || submitting}
					onClick={() => void submit()}
				>
					{submitting || busy ? `${t("settings.saving")}…` : submitLabel}
				</button>
			</div>

			<EndpointCandidatesDialog
				candidates={ep.candidates}
				existing={listedIds}
				picked={ep.picked}
				allSelected={ep.allSelected}
				onToggleOne={ep.toggleOne}
				onToggleAll={ep.toggleAll}
				stale={staleRows}
				pickedStale={pickedStale}
				allStaleSelected={allStaleSelected}
				onToggleStale={toggleStale}
				onToggleAllStale={toggleAllStale}
				onApply={applyFetched}
				onClose={closeFetched}
			/>
		</div>
	);
}
