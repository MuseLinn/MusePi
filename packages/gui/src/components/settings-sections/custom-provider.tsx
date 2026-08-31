/**
 * CustomProviderPane — settings model section's custom-provider domain:
 * the custom providers tab, the add/edit dialog (规范弹窗), and the
 * endpoint candidate picker. Owns its form state and the models.add /
 * models.remove / models.listCustom / models.discover RPC flows.
 * Extracted from model.tsx; the section renders <CustomProviderPane /> only.
 */
import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { DialogFrame } from "../DialogFrame";
import { FadeScroll } from "../FadeScroll";
import { GuiSelect } from "../GuiSelect";

export interface CustomProvider {
	name: string;
	models: { id: string; name?: string; input?: string[]; contextWindow?: number; maxTokens?: number }[];
}

const EMPTY_FORM = {
	name: "",
	baseUrl: "",
	apiKey: "",
	api: "openai-completions",
	modelId: "",
	modelName: "",
	compactionModel: "",
	modelInput: undefined as string[] | undefined,
	modelContextWindow: null as number | null,
	modelMaxTokens: null as number | null,
	adopted: [] as {
		id: string;
		name?: string;
		input?: string[] | null;
		contextWindow?: number | null;
		maxTokens?: number | null;
	}[],
};

export function CustomProviderPane({
	custom,
	rpc,
	sessionId,
	onChanged,
}: {
	custom: CustomProvider[];
	rpc: RpcClient | null;
	sessionId: string | null;
	onChanged(): void;
}): ReactNode {
	const [form, setForm] = useState(EMPTY_FORM);
	// Candidate models an endpoint reported, while the picker dialog is open.
	const [candidates, setCandidates] = useState<{ id: string; name?: string }[] | null>(null);
	// Model ids checked in the candidate picker.
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	// "Fetch available models" in flight, and its failure reason (shown next
	// to the form so the user can still fill models in by hand).
	const [fetchingModels, setFetchingModels] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [formBusy, setFormBusy] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	// Adopted-model capability editor: which adopted row's capability
	// override strip is expanded (null = none). Tracked by row index so a
	// manually added row (whose id starts empty) can still expand its editor.
	const [expandedCaps, setExpandedCaps] = useState<number | null>(null);
	// Custom-provider add dialog: the config form lives in a DialogFrame
	// opened from the "custom providers" tab (not a separate tab — user
	// report: 添加自定义供应商应是有设计规范的弹窗). `addedName` is the
	// transient success feedback after a save.
	const [addOpen, setAddOpen] = useState(false);
	const [addedName, setAddedName] = useState<string | null>(null);
	// When non-null, the dialog is editing this EXISTING custom provider:
	// the form is seeded from its models.yml row and submit merges back via
	// models.add (same RPC — daemon merges by provider name).
	const [editingProvider, setEditingProvider] = useState<string | null>(null);

	/**
	 * Ask the endpoint the form currently shows which models it serves. The
	 * draft — including a key typed but not yet saved — is sent as-is; the
	 * reply is candidates the user picks from, never configuration written
	 * behind them. A protocol with no readable listing or a dead endpoint is
	 * not a dead end: the failure shows next to the form's rows.
	 */
	const fetchModels = async (): Promise<void> => {
		if (!rpc) return;
		setFetchError(null);
		setFetchingModels(true);
		try {
			const result = await rpc.request<{ models?: { id: string; name?: string }[] }>("models.discover", {
				baseUrl: form.baseUrl,
				api: form.api,
				provider: form.name,
				...(form.apiKey ? { apiKey: form.apiKey } : {}),
			});
			const models = result?.models ?? [];
			if (models.length === 0) {
				setFetchError(t("no models found at this endpoint"));
				return;
			}
			setCandidates(models);
			setPicked(new Set(models.map(m => m.id)));
		} catch (err) {
			setFetchError(err instanceof Error ? err.message : String(err));
		} finally {
			setFetchingModels(false);
		}
	};

	/** Adopt the checked candidates into the form's model list. */
	const adoptSelected = (): void => {
		if (!candidates) return;
		const ids = new Set(form.adopted.map(m => m.id));
		const next = [...form.adopted];
		for (const candidate of candidates) {
			if (picked.has(candidate.id) && !ids.has(candidate.id)) {
				next.push({ id: candidate.id, ...(candidate.name ? { name: candidate.name } : {}) });
			}
		}
		setForm(v => ({ ...v, adopted: next }));
		setCandidates(null);
		setPicked(new Set());
	};

	/** Drop one adopted model row from the form (by list index, so a row
	 *  whose id is still empty — a just-added manual row — can be removed). */
	const removeAdopted = (index: number): void => {
		setForm(v => ({ ...v, adopted: v.adopted.filter((_, i) => i !== index) }));
	};

	/** Patch one adopted model row (by list index): id, name, and the
	 *  capability overrides. Index-based so editing a row's id never de-links
	 *  it from its own caps/delete controls. */
	const patchAdopted = (
		index: number,
		patch: Partial<{
			id: string;
			name: string | undefined;
			input: string[] | null;
			contextWindow: number | null;
			maxTokens: number | null;
		}>,
	): void => {
		setForm(v => ({
			...v,
			adopted: v.adopted.map((m, i) => (i === index ? { ...m, ...patch } : m)),
		}));
	};

	/** Append a fresh, editable model row to the adopted list so the user can
	 *  type in models by hand (that's what the "add model" button does — the
	 *  endpoint interrogation alone is not enough when /models is unavailable
	 *  or the provider only wants a couple of known ids). */
	const addManualModel = (): void => {
		setForm(v => ({ ...v, adopted: [...v.adopted, { id: "" }] }));
		setExpandedCaps(form.adopted.length);
	};

	const submitModel = async (): Promise<void> => {
		setFormError(null);
		if (!rpc) return;
		// models.add needs no session (daemon handler only reads params.provider)
		// — a settings page opened without an active session must not silently
		// swallow the click (providers.login had the same guard removed).
		// A provider needs at least one model: either the hand-typed single
		// row or rows adopted from the endpoint interrogation.
		if (!form.name || !form.baseUrl || (form.modelId.length === 0 && form.adopted.length === 0)) {
			setFormError(t("provider name, base URL and at least one model are required"));
			return;
		}
		setFormBusy(true);
		try {
			await rpc.request("models.add", {
				sessionId,
				provider: {
					name: form.name,
					baseUrl: form.baseUrl,
					...(form.apiKey ? { apiKey: form.apiKey } : {}),
					...(form.api !== "openai" ? { api: form.api } : {}),
					models: [
						...form.adopted
							.filter(m => m.id.trim())
							.map(m => ({
								id: m.id,
								...(m.name ? { name: m.name } : {}),
								// input: explicit []/null → restore-to-auto (null deletes
								// the models.yml override); non-empty array writes it;
								// untouched (undefined) omits the field.
								...(Array.isArray(m.input)
									? { input: m.input.length > 0 ? m.input : null }
									: m.input === null
										? { input: null }
										: {}),
								...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
								...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
							})),
						...(form.modelId
							? [
									{
										id: form.modelId,
										...(form.modelName ? { name: form.modelName } : {}),
										...(form.compactionModel.trim() ? { compactionModel: form.compactionModel.trim() } : {}),
										// Capability fields: untouched (undefined) → omit
										// (inherit/keep); "restore to auto" ([]) → null to
										// delete the override; checked → write the array.
										...(form.modelInput !== undefined
											? { input: form.modelInput.length > 0 ? form.modelInput : null }
											: {}),
										...(form.modelContextWindow !== undefined
											? { contextWindow: form.modelContextWindow }
											: {}),
										...(form.modelMaxTokens !== undefined ? { maxTokens: form.modelMaxTokens } : {}),
									},
								]
							: []),
					],
				},
			});
			setForm(EMPTY_FORM);
			// Success feedback: close the dialog and show "provider added / saved"
			// inline where the open button was (the dialog itself can't hold
			// state after closing). The chip fades after a beat.
			const wasEditing = editingProvider !== null;
			setEditingProvider(null);
			setAddOpen(false);
			setAddedName(wasEditing ? `${t("provider saved")} ${form.name}` : form.name);
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
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	const editProvider = async (name: string): Promise<void> => {
		if (!rpc) return;
		try {
			const cfg = await rpc.request<{
				providers?: Record<
					string,
					{
						baseUrl?: string;
						api?: string;
						models?: {
							id: string;
							name?: string;
							input?: string[];
							contextWindow?: number;
							maxTokens?: number;
						}[];
					}
				>;
			}>("models.listCustom", {});
			const row = cfg?.providers?.[name];
			const models = Array.isArray(row?.models) ? row.models : [];
			const hand = models[models.length - 1];
			setForm({
				name,
				baseUrl: row?.baseUrl ?? "",
				apiKey: "",
				api: row?.api ?? "openai-completions",
				modelId: hand?.id ?? "",
				modelName: hand?.name ?? "",
				compactionModel: "",
				modelInput: hand?.input && hand.input.length > 0 ? hand.input : undefined,
				modelContextWindow: hand?.contextWindow ?? null,
				modelMaxTokens: hand?.maxTokens ?? null,
				adopted: models.slice(0, models.length - 1),
			});
			setEditingProvider(name);
			setAddOpen(true);
			setFormError(null);
			setFetchError(null);
		} catch {
			// keep the row; the daemon error is non-fatal for the list
		}
	};

	return (
		<>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("custom providers")}</div>
				<div className="gui-settings-section-desc">{t("custom providers hint")}</div>
				{custom.length === 0 ? (
					<div className="text-[13px] text-[var(--color-text-faint)]">{t("no custom providers")}</div>
				) : (
					custom.map(c => (
						<div key={c.name} className="gui-settings-row">
							<div className="min-w-0 flex-1">
								<div className="gui-settings-row-label">{c.name}</div>
								<div className="truncate text-[13px] text-[var(--color-text-faint)]">
									{c.models.map(m => m.id).join(", ")}
								</div>
							</div>
							<button
								type="button"
								className="gui-btn"
								title={t("edit custom provider")}
								aria-label={t("edit custom provider")}
								onClick={() => void editProvider(c.name)}
							>
								<Icon name="edit-2" className="h-3.5 w-3.5" />
							</button>
							<button type="button" className="gui-btn" onClick={() => void removeProvider(c.name)}>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
							</button>
						</div>
					))
				)}
				{addedName ? (
					<div className="mt-2 flex items-center gap-2 text-[13px] text-[var(--color-accent)]">
						<Icon name="check" className="h-3.5 w-3.5" />
						<span>{t("provider added")}</span>
					</div>
				) : (
					<button
						type="button"
						className="gui-connect-add"
						onClick={() => {
							setAddOpen(true);
							setFormError(null);
						}}
					>
						<Icon name="add-circle" className="h-4 w-4" />
						<span>{t("add custom provider")}</span>
					</button>
				)}
			</div>
			{/* Custom-provider add dialog (规范弹窗, not a tab — user report:
			 * 添加自定义供应商应是有设计规范的弹窗). The form is the same
			 * state as the old add-tab; the candidates DialogFrame nests
			 * inside it (no conflict — both are portal-to-body). Because
			 * both DialogFrames listen for Escape on document (capture),
			 * closing this one must first (and only) dismiss the nested
			 * candidate picker — otherwise one Escape would nuke a filled
			 * form. On close without candidates, reset the form. */}
			<DialogFrame
				open={addOpen}
				onClose={() => {
					if (candidates !== null) {
						setCandidates(null);
						setPicked(new Set());
						return;
					}
					setAddOpen(false);
					setEditingProvider(null);
					setFormError(null);
					setForm(EMPTY_FORM);
					setFetchError(null);
				}}
				className="gui-dialog--settings"
				label={editingProvider ? t("edit custom provider") : t("add custom provider")}
			>
				<div className="gui-dialog-head">
					<div className="text-[14px] font-medium">
						{editingProvider ? t("edit custom provider") : t("add custom provider")}
					</div>
				</div>
				<div className="flex flex-col gap-2 p-4">
					<input
						className="gui-input"
						placeholder={t("provider name")}
						value={form.name}
						onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
					/>
					<input
						className="gui-input"
						placeholder="https://api.example.com/v1"
						value={form.baseUrl}
						onChange={e => setForm(v => ({ ...v, baseUrl: e.target.value }))}
					/>
					<input
						className="gui-input"
						placeholder={t("api key (optional)")}
						type="password"
						value={form.apiKey}
						onChange={e => setForm(v => ({ ...v, apiKey: e.target.value }))}
					/>
					{/* Fetch available models: interrogates the endpoint the
					 * form currently shows (including an unsaved key), and
					 * offers the reply as adoptable candidates. */}
					<div className="flex items-center gap-2">
						<button
							type="button"
							className="gui-btn"
							disabled={!form.baseUrl || fetchingModels || formBusy}
							title={form.baseUrl ? undefined : t("enter a base URL to fetch models")}
							onClick={() => void fetchModels()}
						>
							{fetchingModels ? t("fetching models…") : t("fetch available models")}
						</button>
						<button
							type="button"
							className="gui-btn"
							disabled={formBusy}
							title={t("add model hint")}
							onClick={addManualModel}
						>
							{t("add model")}
						</button>
						{form.adopted.length > 0 && (
							<span className="text-[12px] text-[var(--color-text-faint)]">
								{t("adopted models")}: {form.adopted.length}
							</span>
						)}
					</div>
					{fetchError && <div className="text-[13px] text-[var(--color-error)]">{fetchError}</div>}
					{form.adopted.length > 0 && (
						<div className="flex flex-col gap-1">
							{form.adopted.map((m, index) => {
								const capsOpen = expandedCaps === index;
								return (
									<div key={index} className="flex flex-col gap-1">
										<div className="flex items-center gap-2">
											<input
												className="gui-input flex-1"
												placeholder={t("model id")}
												value={m.id}
												onChange={e => patchAdopted(index, { id: e.target.value })}
											/>
											<input
												className="gui-input flex-1"
												placeholder={t("model name (optional)")}
												value={m.name ?? ""}
												onChange={e => patchAdopted(index, { name: e.target.value || undefined })}
											/>
											<button
												type="button"
												className="gui-btn"
												title={t("model capabilities")}
												aria-label={`${t("model capabilities")} ${m.id}`}
												onClick={() => setExpandedCaps(capsOpen ? null : index)}
											>
												<Icon name="settings-3" className="h-3.5 w-3.5" />
											</button>
											<button
												type="button"
												className="gui-btn"
												aria-label={`${t("delete")} ${m.id}`}
												onClick={() => removeAdopted(index)}
											>
												<Icon name="delete-bin" className="h-3.5 w-3.5" />
											</button>
										</div>
										{capsOpen && (
											<div className="flex flex-col gap-1 rounded-lg border border-[var(--border-strong)] p-2">
												<div className="flex items-center justify-between">
													<div className="text-[12px] font-medium text-[var(--color-text-muted)]">
														{t("model capabilities")}
													</div>
													<button
														type="button"
														className="text-[12px] text-[var(--color-accent)]"
														title={t("restore capabilities to auto")}
														onClick={() =>
															patchAdopted(index, {
																input: null,
																contextWindow: null,
																maxTokens: null,
															})
														}
													>
														{t("restore to auto")}
													</button>
												</div>
												<div className="flex items-center gap-3">
													{(["text", "image", "video"] as const).map(modality => (
														<label key={modality} className="flex items-center gap-1 text-[12px]">
															<input
																type="checkbox"
																checked={(m.input ?? []).includes(modality)}
																onChange={() =>
																	patchAdopted(index, {
																		input: (m.input ?? []).includes(modality)
																			? (m.input ?? []).filter(x => x !== modality)
																			: [...(m.input ?? []), modality],
																	})
																}
															/>
															{modality}
														</label>
													))}
												</div>
												<div className="flex gap-2">
													<input
														className="gui-input flex-1"
														placeholder={t("context window (optional)")}
														type="number"
														min={0}
														value={m.contextWindow ?? ""}
														onChange={e =>
															patchAdopted(index, {
																contextWindow: e.target.value ? Number(e.target.value) : null,
															})
														}
													/>
													<input
														className="gui-input flex-1"
														placeholder={t("max output tokens (optional)")}
														type="number"
														min={0}
														value={m.maxTokens ?? ""}
														onChange={e =>
															patchAdopted(index, {
																maxTokens: e.target.value ? Number(e.target.value) : null,
															})
														}
													/>
												</div>
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
					<div className="flex gap-2">
						<input
							className="gui-input flex-1"
							placeholder={t("model id")}
							value={form.modelId}
							onChange={e => setForm(v => ({ ...v, modelId: e.target.value }))}
						/>
						<input
							className="gui-input flex-1"
							placeholder={t("model name (optional)")}
							value={form.modelName}
							onChange={e => setForm(v => ({ ...v, modelName: e.target.value }))}
						/>
					</div>
					<input
						className="gui-input"
						placeholder={t("compaction model id (optional)")}
						value={form.compactionModel}
						onChange={e => setForm(v => ({ ...v, compactionModel: e.target.value }))}
					/>
					<GuiSelect
						className="gui-input"
						value={form.api}
						onChange={nv => setForm(v => ({ ...v, api: nv }))}
						options={[
							{ value: "openai-completions", label: "openai" },
							{ value: "openai-responses", label: "openai responses" },
							{ value: "anthropic-messages", label: "anthropic" },
							{ value: "google-generative-ai", label: "google" },
						]}
					/>
					{/* Per-model capability overrides for the hand-typed row:
					 * input modalities (text/image/video) plus context window
					 * and max output tokens. These fill models.yml fields that
					 * otherwise inherit from the models.dev/bundled fallback —
					 * the escape hatch when the fallback is wrong or unknown.
					 * "Restore to auto" clears every override so the model
					 * goes back to the auto-fitted capabilities again. */}
					<div className="flex flex-col gap-1 rounded-lg border border-[var(--border-strong)] p-2">
						<div className="flex items-center justify-between">
							<div className="text-[12px] font-medium text-[var(--color-text-muted)]">
								{t("model capabilities")}
							</div>
							<button
								type="button"
								className="text-[12px] text-[var(--color-accent)]"
								title={t("restore capabilities to auto")}
								onClick={() =>
									setForm(v => ({
										...v,
										modelInput: [],
										modelContextWindow: null,
										modelMaxTokens: null,
									}))
								}
							>
								{t("restore to auto")}
							</button>
						</div>
						<div className="flex items-center gap-3">
							{(["text", "image", "video"] as const).map(modality => (
								<label key={modality} className="flex items-center gap-1 text-[12px]">
									<input
										type="checkbox"
										checked={(form.modelInput ?? []).includes(modality)}
										onChange={() =>
											setForm(v => {
												const current = v.modelInput ?? [];
												const next = current.includes(modality)
													? current.filter(m => m !== modality)
													: [...current, modality];
												return { ...v, modelInput: next };
											})
										}
									/>
									{modality}
								</label>
							))}
						</div>
						<div className="flex gap-2">
							<input
								className="gui-input flex-1"
								placeholder={t("context window (optional)")}
								type="number"
								min={0}
								value={form.modelContextWindow ?? ""}
								onChange={e =>
									setForm(v => ({
										...v,
										modelContextWindow: e.target.value ? Number(e.target.value) : null,
									}))
								}
							/>
							<input
								className="gui-input flex-1"
								placeholder={t("max output tokens (optional)")}
								type="number"
								min={0}
								value={form.modelMaxTokens ?? ""}
								onChange={e =>
									setForm(v => ({
										...v,
										modelMaxTokens: e.target.value ? Number(e.target.value) : null,
									}))
								}
							/>
						</div>
					</div>
					{formError && <div className="text-[13px] text-[var(--color-error)]">{formError}</div>}
					<button
						type="button"
						className="gui-btn gui-btn-approve"
						disabled={formBusy}
						onClick={() => void submitModel()}
					>
						{formBusy ? `${t("saving")}…` : editingProvider ? t("save changes") : t("add provider")}
					</button>
				</div>
				{/* Candidate picker for "fetch available models": the endpoint's
				 * reply as a checkbox list the user adopts from. Rendered
				 * inside the dialog frame so it portals to body independently. */}
				<DialogFrame
					open={candidates !== null}
					onClose={() => {
						setCandidates(null);
						setPicked(new Set());
					}}
					className="gui-dialog--confirm"
					label={t("available models")}
				>
					<div className="gui-dialog-head">
						<div className="text-[14px] font-medium">{t("available models")}</div>
						<button type="button" className="gui-btn" onClick={() => void adoptSelected()}>
							{t("adopt selected")}
						</button>
					</div>
					<div className="p-3">
						<div className="mb-2 flex items-center justify-between">
							<span className="text-[13px] text-[var(--color-text-faint)]">{t("select models to add")}</span>
							<button
								type="button"
								className="text-[12px] text-[var(--color-accent)]"
								onClick={() => {
									if (candidates && picked.size === candidates.length) {
										setPicked(new Set());
									} else if (candidates) {
										setPicked(new Set(candidates.map(m => m.id)));
									}
								}}
							>
								{picked.size > 0 && candidates && picked.size === candidates.length
									? t("deselect all")
									: t("select all")}
							</button>
						</div>
						<FadeScroll className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
							{(candidates ?? []).map(m => (
								<label key={m.id} className="flex cursor-pointer items-center gap-2">
									<input
										type="checkbox"
										checked={picked.has(m.id)}
										onChange={() => {
											const next = new Set(picked);
											if (next.has(m.id)) next.delete(m.id);
											else next.add(m.id);
											setPicked(next);
										}}
									/>
									<span className="flex-1 truncate font-mono text-[13px]">{m.id}</span>
									{m.name && m.name !== m.id && (
										<span className="truncate text-[12px] text-[var(--color-text-faint)]">{m.name}</span>
									)}
								</label>
							))}
						</FadeScroll>
					</div>
				</DialogFrame>
			</DialogFrame>
		</>
	);
}
