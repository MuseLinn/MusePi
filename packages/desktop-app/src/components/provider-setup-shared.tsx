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
import { t } from "@musepi/guest-client";
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
			<span className="gui-obo-quick-label">{t("quick providers")}</span>
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
	 *  into its own adopted shape (settings rows carry capability fields,
	 *  onboarding rows don't; the hook stays shape-agnostic). */
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
 *  a checkbox list the user adopts from. Nothing here writes
 *  configuration — adopted rows land in the caller's form only. Nested
 *  inside the caller's own DialogFrame (settings) or card (onboarding);
 *  the frame itself portals to body either way. */
export function EndpointCandidatesDialog({
	candidates,
	picked,
	allSelected,
	onToggleOne,
	onToggleAll,
	onAdopt,
	onClose,
}: {
	candidates: { id: string; name?: string }[] | null;
	picked: ReadonlySet<string>;
	allSelected: boolean;
	onToggleOne(id: string): void;
	onToggleAll(): void;
	onAdopt(): void;
	onClose(): void;
}): ReactNode {
	return (
		<DialogFrame
			open={candidates !== null}
			onClose={onClose}
			className="gui-dialog--confirm"
			label={t("available models")}
		>
			<div className="gui-dialog-head">
				<div className="text-[14px] font-medium">{t("available models")}</div>
				<button type="button" className="gui-btn" onClick={onAdopt}>
					{t("adopt selected")}
				</button>
			</div>
			<div className="p-3">
				<div className="mb-2 flex items-center justify-between">
					<span className="text-[13px] text-[var(--color-text-faint)]">{t("select models to add")}</span>
					<button type="button" className="text-[12px] text-[var(--color-accent)]" onClick={onToggleAll}>
						{allSelected ? t("deselect all") : t("select all")}
					</button>
				</div>
				<FadeScroll className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
					{(candidates ?? []).map(m => (
						<label key={m.id} className="flex cursor-pointer items-center gap-2">
							<input type="checkbox" checked={picked.has(m.id)} onChange={() => onToggleOne(m.id)} />
							<span className="flex-1 truncate font-mono text-[13px]">{m.id}</span>
							{m.name && m.name !== m.id && (
								<span className="truncate text-[12px] text-[var(--color-text-faint)]">{m.name}</span>
							)}
						</label>
					))}
				</FadeScroll>
			</div>
		</DialogFrame>
	);
}
