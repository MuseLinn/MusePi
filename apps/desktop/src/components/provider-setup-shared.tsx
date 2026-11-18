/**
 * Shared custom-provider "quick channel": quick-fill chips
 * (QUICK_PROVIDERS) and the "fetch available models" discovery flow
 * (models.discover draft query → candidates picker → adopt into the
 * caller's form). Single authoritative implementation — previously
 * copy-pasted between the onboarding ProviderSetup custom form and the
 * settings custom-provider dialog (ux-onboarding-architecture §4.3:
 * 设置页是完整表单所在地，引导只做快捷通道，两处不养两套逻辑).
 *
 * Semantics preserved from the originals: the draft — including a key
 * typed but not yet saved — is sent as-is to models.discover and the
 * daemon never persists it; adoption writes into the FORM only (the
 * picker never writes configuration); failures render next to the form
 * (never a dialog).
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useState } from "react";
import { tapFeedback } from "../lib/haptic";
import type { RpcClient } from "../lib/rpc";
import { DialogFrame } from "./DialogFrame";
import { FadeScroll } from "./FadeScroll";

/** One-tap fills for common OpenAI-compatible providers — the object of
 *  the quick channel is "开箱即用": pick a chip, drop in the API key, go. */
export const QUICK_PROVIDERS = [
	{ name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
	{ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
	{ name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1" },
	{ name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
] as const;

/** Base-URL placeholder per API protocol — the hint must match the
 *  endpoint shape the selected protocol actually talks to (Google
 *  /v1beta vs the OpenAI /v1 chat-completions shape). Anthropic keeps
 *  the `/v1` suffix: the SDK strips it before appending `/v1/messages`
 *  (model-discovery.ts:929 — a `/v1/messages` baseUrl would double up). */
export const URL_HINTS: Record<string, string> = {
	"openai-completions": "https://api.example.com/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.anthropic.com/v1",
	"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

/** Quick-fill chip row — one chip per QUICK_PROVIDERS entry; picking
 *  fills the caller's provider name + base URL (the API key stays
 *  user-typed, chips never carry credentials). Class names keep the
 *  gui-obo-* prefix (styled in gui-widgets.css) — they are generic
 *  pills, safe outside the onboarding card. */
export function QuickProviderChips({ onPick }: { onPick(name: string, baseUrl: string): void }): ReactNode {
	return (
		<div className="gui-obo-quick">
			<span className="gui-obo-quick-label">{t("settings.quickProviders")}</span>
			<div className="gui-obo-quick-chips">
				{QUICK_PROVIDERS.map(qp => (
					<button
						type="button"
						key={qp.name}
						className="gui-obo-quick-chip"
						onClick={() => {
							tapFeedback();
							onPick(qp.name, qp.baseUrl);
						}}
					>
						{qp.name}
					</button>
				))}
			</div>
		</div>
	);
}

/** The form draft the discovery queries — read fresh on every fetch. */
export interface EndpointDraft {
	name: string;
	baseUrl: string;
	apiKey: string;
	api: string;
}

/** Discovery state machine shared by both custom-provider forms. */
export interface EndpointModels {
	candidates: { id: string; name?: string }[] | null;
	picked: ReadonlySet<string>;
	fetchingModels: boolean;
	fetchError: string | null;
	setFetchError(message: string | null): void;
	fetchModels(): Promise<void>;
	closePicker(): void;
	toggleOne(id: string): void;
	toggleAll(): void;
	allSelected: boolean;
	/** Candidates checked but not yet adopted — the caller merges them
	 *  into its own draft rows; the hook stays shape-agnostic so one form can
	 *  own both lists. */
	pickedNew(adoptedIds: Iterable<string>): { id: string; name?: string }[];
}

export function useEndpointModels(rpc: RpcClient | null, draft: EndpointDraft): EndpointModels {
	// Candidate models an endpoint reported, while the picker dialog is open.
	const [candidates, setCandidates] = useState<{ id: string; name?: string }[] | null>(null);
	// Model ids checked in the candidate picker.
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	// "Fetch available models" in flight, and its failure reason (shown next
	// to the form so the user can still fill models in by hand).
	const [fetchingModels, setFetchingModels] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);

	/** Ask the endpoint the form currently shows which models it serves. The
	 *  draft — including a key typed but not yet saved — is sent as-is; the
	 *  reply is candidates the user picks from, never configuration written
	 *  behind them. A protocol with no readable listing or a dead endpoint
	 *  is not a dead end: the failure shows next to the form's rows. */
	const fetchModels = async (): Promise<void> => {
		if (!rpc) return;
		setFetchError(null);
		setFetchingModels(true);
		try {
			const result = await rpc.request<{ models?: { id: string; name?: string }[] }>("models.discover", {
				baseUrl: draft.baseUrl,
				api: draft.api,
				provider: draft.name,
				...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
			});
			const models = result?.models ?? [];
			if (models.length === 0) {
				setFetchError(t("settings.noModelsFoundEndpoint"));
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

	const closePicker = (): void => {
		setCandidates(null);
		setPicked(new Set());
	};

	const toggleOne = (id: string): void => {
		setPicked(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const allSelected = candidates !== null && picked.size === candidates.length;

	const toggleAll = (): void => {
		if (candidates && picked.size === candidates.length) setPicked(new Set());
		else if (candidates) setPicked(new Set(candidates.map(m => m.id)));
	};

	const pickedNew = (adoptedIds: Iterable<string>): { id: string; name?: string }[] => {
		const have = new Set(adoptedIds);
		const out: { id: string; name?: string }[] = [];
		for (const candidate of candidates ?? []) {
			if (picked.has(candidate.id) && !have.has(candidate.id)) {
				out.push({ id: candidate.id, ...(candidate.name ? { name: candidate.name } : {}) });
			}
		}
		return out;
	};

	return {
		candidates,
		picked,
		fetchingModels,
		fetchError,
		setFetchError,
		fetchModels,
		closePicker,
		toggleOne,
		toggleAll,
		allSelected,
		pickedNew,
	};
}

/** Candidate picker for "fetch available models": the endpoint's reply as
 *  a checkbox list the user adopts from, plus the current rows the endpoint
 *  no longer returns. Applying merges the first and removes the second, so a
 *  fetch updates the list instead of piling models up. Nothing here writes
 *  configuration — the caller edits its own draft. Nested inside the caller's
 *  own DialogFrame; the frame itself portals to body either way. */
export function EndpointCandidatesDialog({
	candidates,
	existing,
	picked,
	allSelected,
	onToggleOne,
	onToggleAll,
	stale,
	pickedStale,
	allStaleSelected,
	onToggleStale,
	onToggleAllStale,
	onApply,
	onClose,
}: {
	candidates: { id: string; name?: string }[] | null;
	/** Ids already in the draft: offered as listed, not as new rows. */
	existing: ReadonlySet<string>;
	picked: ReadonlySet<string>;
	allSelected: boolean;
	onToggleOne(id: string): void;
	onToggleAll(): void;
	/** Draft rows the endpoint did not return; checked ones are removed. */
	stale: { id: string; name?: string }[];
	pickedStale: ReadonlySet<string>;
	allStaleSelected: boolean;
	onToggleStale(id: string): void;
	onToggleAllStale(): void;
	onApply(): void;
	onClose(): void;
}): ReactNode {
	const added = (candidates ?? []).filter(model => picked.has(model.id) && !existing.has(model.id)).length;
	const removed = pickedStale.size;
	const nothingToDo = added === 0 && removed === 0;
	return (
		<DialogFrame
			open={candidates !== null}
			onClose={onClose}
			className="gui-dialog--models"
			label={t("settings.availableModels")}
		>
			<div className="gui-dialog-head">
				<div className="text-[14px] font-medium">{t("settings.availableModels")}</div>
				<button type="button" className="gui-btn" onClick={onClose}>
					{t("settings.close")}
				</button>
			</div>
			<div className="flex flex-col gap-3 p-3">
				<section>
					<div className="mb-2 flex items-center justify-between">
						<span className="text-[13px] font-medium">
							{t("settings.modelsToAdd")} · {(candidates ?? []).filter(m => !existing.has(m.id)).length}
						</span>
						<button type="button" className="text-[12px] text-[var(--color-accent)]" onClick={onToggleAll}>
							{allSelected ? t("settings.deselectAll") : t("settings.selectAll")}
						</button>
					</div>
					{candidates !== null && candidates.length === 0 ? (
						<div className="text-[13px] text-[var(--color-text-faint)]">
							{t("settings.noModelsFoundEndpoint")}
						</div>
					) : (
						<FadeScroll className="flex max-h-[220px] flex-col gap-1 overflow-y-auto">
							{(candidates ?? []).map(model => {
								const listed = existing.has(model.id);
								return (
									<label key={model.id} className="flex cursor-pointer items-center gap-2">
										<input
											type="checkbox"
											checked={listed || picked.has(model.id)}
											disabled={listed}
											onChange={() => onToggleOne(model.id)}
										/>
										<span className="flex-1 truncate font-mono text-[13px]">{model.id}</span>
										{listed ? (
											<span className="text-[12px] text-[var(--color-text-faint)]">
												{t("settings.modelAlreadyListed")}
											</span>
										) : model.name && model.name !== model.id ? (
											<span className="truncate text-[12px] text-[var(--color-text-faint)]">
												{model.name}
											</span>
										) : null}
									</label>
								);
							})}
						</FadeScroll>
					)}
				</section>
				{stale.length > 0 ? (
					<section>
						<div className="mb-1 flex items-center justify-between">
							<span className="text-[13px] font-medium">
								{t("settings.modelsMissing")} · {stale.length}
							</span>
							<button
								type="button"
								className="text-[12px] text-[var(--color-accent)]"
								onClick={onToggleAllStale}
							>
								{allStaleSelected ? t("settings.deselectAll") : t("settings.selectAll")}
							</button>
						</div>
						<div className="mb-1 text-[12px] text-[var(--color-text-faint)]">
							{t("settings.modelsMissingHint")}
						</div>
						<FadeScroll className="flex max-h-[160px] flex-col gap-1 overflow-y-auto">
							{stale.map(model => (
								<label key={model.id} className="flex cursor-pointer items-center gap-2">
									<input
										type="checkbox"
										checked={pickedStale.has(model.id)}
										onChange={() => onToggleStale(model.id)}
									/>
									<span className="flex-1 truncate font-mono text-[13px] text-[var(--color-text-muted)] line-through">
										{model.id}
									</span>
								</label>
							))}
						</FadeScroll>
					</section>
				) : null}
				<div className="flex justify-end">
					<button type="button" className="gui-btn gui-btn-approve" disabled={nothingToDo} onClick={onApply}>
						{added + removed === 0
							? t("settings.applyModelChanges", { add: 0, remove: 0 })
							: t("settings.applyModelChanges", { add: added, remove: removed })}
					</button>
				</div>
			</div>
		</DialogFrame>
	);
}
