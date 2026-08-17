/**
 * First-launch onboarding overlay (settings footer 引导 entry + auto-open
 * on first run). ZCode-style two-pane primer: the left pane holds step
 * content with a morphing icon (MorphIcon spring between step icons); the
 * right pane is an animated, purely-visual mini-demo of each feature
 * (CSS keyframes, replays on step switch).
 *
 * Step 4 is interactive — provider setup: builtin providers can OAuth-login
 * or import an API key (daemon providers.* RPCs, same flow as Settings), and
 * custom OpenAI-compatible endpoints get a one-shot test-connection button
 * (providers.testConnection) before models.add persists them. Step 5 is
 * appearance: language + light/dark theme, applied live. A fresh install can
 * therefore go from zero to a working model without touching settings.
 *
 * Completing it stores omp-gui-onboarding-done so it never auto-opens
 * again; the settings footer button reopens it on demand.
 */

import {
	setLocale,
	t,
	type TranslationKey,
	useAccentPreference,
	useThemePreference,
} from "@musepi/collab-web";
import { KeyRound, Languages, MessagesSquare, Palette, Settings2, Sparkles, SquareTerminal } from "lucide";
import { MorphIcon } from "morphicons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { tapFeedback } from "../lib/haptic";
import { DONE_KEY, onboardingPending } from "../lib/onboarding";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { ColorPickerPanel } from "./ColorPicker";

/** Exit animation duration (mirrors gui-obo-card-out below). */
const ONBOARDING_EXIT_MS = 200;
import type { RpcClient, StreamEvent } from "../lib/rpc";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon } from "../vendor/oc-icons";
import { AgentAvatar } from "./AgentAvatar";
import { PersonalizeSetup } from "./PersonalizeSetup";
import { PetSprite } from "./PetSprite";
import { petForId } from "../lib/pet";

const STEPS = [
	{ icon: Languages, key: "onboarding step1" },
	{ icon: Palette, key: "onboarding step2" },
	{ icon: MessagesSquare, key: "onboarding step3" },
	{ icon: SquareTerminal, key: "onboarding step4" },
	{ icon: Settings2, key: "onboarding step5" },
	{ icon: KeyRound, key: "onboarding step6" },
	{ icon: Sparkles, key: "onboarding step7" },
] as const;

/** Feature bullets per promo step (steps 3–5) — each page carries real
 *  product facts, not a single sentence. */
const PROMO_FEATURES = {
	"onboarding step3": ["onboarding feat s1", "onboarding feat s2", "onboarding feat s3"],
	"onboarding step4": ["onboarding feat c1", "onboarding feat c2", "onboarding feat c3"],
	"onboarding step5": ["onboarding feat t1", "onboarding feat t2", "onboarding feat t3", "onboarding feat t4"],
} as const;

/** One-tap fills for common OpenAI-compatible providers — the object of the
 *  step is "开箱即用": pick a chip, drop in the API key, go. */
const QUICK_PROVIDERS = [
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
const URL_HINTS: Record<string, string> = {
	"openai-completions": "https://api.example.com/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.anthropic.com/v1",
	"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

/** Wire shapes from daemon providers.list (SettingsView parity). */
interface BuiltinProviderInfo {
	id: string;
	name: string;
	loggedIn: boolean;
	available: boolean;
}
interface ApiProviderInfo {
	id: string;
	name: string;
	configured: boolean;
}

/** Animated feature previews — pure CSS loops, no live data. The window
 *  mock is the same "software window" frame every step's visual uses
 *  (统一窗口尺寸演示), recolored by the live theme/accent vars. */
/**
 * Step demos: ONE morph window frame (traffic-light title bar + sidebar)
 * persists across every step — the sidebar's active item transfers
 * smoothly, and only the content pane remounts per step so each step's
 * entrance animations replay. The right preview container (rounded panel)
 * never remounts; the content morphs inside it.
 */
function StepDemo({ step, petMode }: { step: number; petMode: "input" | "desktop" }): ReactNode {
	// Sidebar active row: steps 0-2 highlight their row, the rest use row 1.
	const sideActive = [0, 1, 2].includes(step) ? step : 0;
	return (
		<div className="gui-obo-demo">
			<div className="gui-obo-morph-window">
				<div className="gui-obo-window-bar">
					<span className="gui-obo-window-light gui-obo-window-light--close" />
					<span className="gui-obo-window-light gui-obo-window-light--min" />
					<span className="gui-obo-window-light gui-obo-window-light--max" />
				</div>
				<div className="gui-obo-morph-body">
					<div className="gui-obo-morph-side">
						{[0, 1, 2].map(i => (
							<div
								key={i}
								className={`gui-obo-morph-side-item${sideActive === i ? " gui-obo-morph-side-item--active" : ""}`}
							/>
						))}
					</div>
					<div className="gui-obo-morph-content" key={`morph-${step}`}>
						<DemoContent step={step} petMode={petMode} />
					</div>
				</div>
			</div>
		</div>
	);
}

function DemoContent({ step, petMode }: { step: number; petMode: "input" | "desktop" }): ReactNode {
	// Hooks MUST run before every early return (React hook rules — the step
	// branches below bail out early). The pet state is only rendered at
	// step 6, but loading it unconditionally is cheap and keeps the hook
	// count stable across step changes.
	const [pet, setPet] = useState<ReturnType<typeof petForId> | null>(() => {
		try {
			return petForId(localStorage.getItem("omp-gui-pet-id") ?? "musepi");
		} catch {
			return petForId("musepi");
		}
	});
	useEffect(() => {
		const on = (): void => {
			try {
				setPet(petForId(localStorage.getItem("omp-gui-pet-id") ?? "musepi"));
			} catch {
				// ignore
			}
		};
		window.addEventListener("omp-pet-changed", on);
		return () => window.removeEventListener("omp-pet-changed", on);
	}, []);
	if (step === 0) {
		// Language — bilingual speech bubbles.
		return (
			<div className="gui-obo-morph-fill">
				<div className="gui-obo-main-bar" />
				<div className="gui-obo-lang-row">
					<span className="gui-obo-lang-bubble">你好，MusePi</span>
				</div>
				<div className="gui-obo-lang-row gui-obo-lang-row--alt">
					<span className="gui-obo-lang-bubble">Hello, MusePi</span>
				</div>
			</div>
		);
	}
	if (step === 1) {
		// Appearance — themed accent + content lines (live CSS vars).
		return (
			<div className="gui-obo-morph-fill">
				<div className="gui-obo-main-bar" />
				<div className="gui-obo-main-lines" />
				<div className="gui-obo-theme-accent" />
			</div>
		);
	}
	if (step === 2) {
		// Sessions — sidebar navigation mock.
		return (
			<div className="gui-obo-morph-fill">
				<div className="gui-obo-main-bar" />
				<div className="gui-obo-main-lines" />
			</div>
		);
	}
	if (step === 3) {
		// Chat — conversation mock.
		return (
			<div className="gui-obo-morph-fill gui-obo-morph-fill--chat">
				<div className="gui-obo-bubble gui-obo-bubble--user" />
				<div className="gui-obo-bubble gui-obo-bubble--assistant" />
				<div className="gui-obo-typing">
					<span />
					<span />
					<span />
				</div>
			</div>
		);
	}
	if (step === 4) {
		// Settings — toggle rows mock.
		return (
			<div className="gui-obo-morph-fill">
				<div className="gui-obo-setting-row">
					<div className="gui-obo-setting-label" />
					<div className="gui-obo-toggle gui-obo-toggle--on" />
				</div>
				<div className="gui-obo-setting-row">
					<div className="gui-obo-setting-label" />
					<div className="gui-obo-toggle" />
				</div>
				<div className="gui-obo-setting-row gui-obo-setting-row--open">
					<div className="gui-obo-setting-label" />
					<div className="gui-obo-setting-expand" />
				</div>
			</div>
		);
	}
	if (step === 5) {
		// Provider — provider rows; the middle one cycles 登录 → ✓ 已登录
		// (the login morph the setup produces).
		return (
			<div className="gui-obo-morph-fill gui-obo-providers">
				<div className="gui-obo-provider-row">
					<span className="gui-obo-provider-dot" />
					<span className="gui-obo-provider-skel" />
					<span className="gui-obo-provider-ok">✓ 已登录</span>
				</div>
				<div className="gui-obo-provider-row">
					<span className="gui-obo-provider-dot" />
					<span className="gui-obo-provider-skel" />
					<span className="gui-obo-provider-btn">
						<span className="gui-obo-login-txt">{t("login")}</span>
						<span className="gui-obo-login-ok">✓ 已登录</span>
					</span>
				</div>
				<div className="gui-obo-provider-row">
					<span className="gui-obo-provider-dot" />
					<span className="gui-obo-provider-skel" />
					<span className="gui-obo-provider-btn">{t("login")}</span>
				</div>
			</div>
		);
	}
	// Step 6 — personalization: chat rows with the LIVE AgentAvatar
	// (follows the orbs/hexagon/star choice) + the composer with the pet
	// docked at its top-right — the REAL selected pet (omp-gui-pet-id,
	// builtin or petdex) shown as its static rest frame, like the actual
	// composer (gui-composer-pet positioning). The pet is SMALLER than the
	// real composer's (the mock window is scaled) and only shows in
	// "input" mode — "desktop" moves it to its own window.
	return (
		<div className="gui-obo-morph-fill gui-obo-morph-fill--chat">
			<div className="gui-obo-pers-row gui-obo-pers-row--user">
				<div className="gui-obo-bubble gui-obo-bubble--user" />
			</div>
			<div className="gui-obo-pers-row">
				<AgentAvatar size={20} />
				<div className="gui-obo-bubble gui-obo-bubble--assistant" />
			</div>
			<div className="gui-obo-pers-row">
				<AgentAvatar size={20} />
				<div className="gui-obo-pers-typing">
					<span />
					<span />
					<span />
				</div>
			</div>
			<div className="gui-obo-pers-composer">
				<div className="gui-obo-pers-input" />
				{petMode === "input" && pet && (
					<div className="gui-obo-pers-pet" aria-hidden="true">
						<PetSprite mood="rest" pet={pet} size={16} frozen />
					</div>
				)}
			</div>
		</div>
	);
}

/** Feature bullets shown under promo-step bodies (steps 3–5). */
function FeatureList({ keys }: { keys: readonly TranslationKey[] }): ReactNode {
	return (
		<div className="gui-obo-features">
			{keys.map(key => (
				<div key={key} className="gui-obo-feature">
					<span className="gui-obo-feature-check">
						<Icon name="check" className="h-3.5 w-3.5" />
					</span>
					<span>{t(key)}</span>
				</div>
			))}
		</div>
	);
}

const EMPTY_FORM = {
	name: "",
	baseUrl: "",
	apiKey: "",
	api: "openai-completions",
	modelId: "",
	modelName: "",
};

/** Step 4 — provider setup: builtin OAuth/API-key rows + custom
 *  OpenAI-compatible form with a live connection test. */
function ProviderSetup({
	rpc,
	providerEvent,
}: {
	rpc: RpcClient | null;
	providerEvent: StreamEvent | null;
}): ReactNode {
	const [tab, setTab] = useState<"builtin" | "custom">("builtin");
	const [builtins, setBuiltins] = useState<BuiltinProviderInfo[] | null>(null);
	const [apiProviders, setApiProviders] = useState<ApiProviderInfo[]>([]);
	// Custom form.
	const [form, setForm] = useState(EMPTY_FORM);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<{ name: string } | null>(null);
	// Connection test.
	const [testing, setTesting] = useState(false);
	const [testOk, setTestOk] = useState(false);
	// OAuth login envelope (provider-auth / provider-prompt / provider-progress).
	const [loginState, setLoginState] = useState<{
		providerId: string;
		url?: string;
		launchUrl?: string;
		instructions?: string;
		message?: string;
		waitingInput?: boolean;
	} | null>(null);
	const [loginBusy, setLoginBusy] = useState(false);
	const [promptValue, setPromptValue] = useState("");
	const [copied, setCopied] = useState(false);
	// API-key import inline editor.
	const [importTarget, setImportTarget] = useState<ApiProviderInfo | null>(null);
	const [importValue, setImportValue] = useState("");
	const [importBusy, setImportBusy] = useState(false);

	const loadProviders = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		try {
			const raw = (await rpc.request<unknown>("providers.list", {})) as
				| BuiltinProviderInfo[]
				| { oauth?: BuiltinProviderInfo[]; api?: ApiProviderInfo[] }
				| null;
			if (Array.isArray(raw)) {
				setBuiltins(raw);
				setApiProviders([]);
			} else {
				setBuiltins(Array.isArray(raw?.oauth) ? raw.oauth : []);
				setApiProviders(Array.isArray(raw?.api) ? raw.api : []);
			}
		} catch {
			setBuiltins([]);
		}
	}, [rpc]);

	useEffect(() => {
		void loadProviders();
	}, [loadProviders]);

	// Provider auth/prompt envelopes drive the inline login panel.
	useEffect(() => {
		if (!providerEvent) return;
		const p = providerEvent.payload as {
			providerId?: string;
			url?: string;
			launchUrl?: string;
			instructions?: string;
			message?: string;
		};
		if (providerEvent.kind === "provider-auth") {
			setLoginState({
				providerId: p.providerId ?? "",
				...(p.url ? { url: p.url } : {}),
				...(p.launchUrl ? { launchUrl: p.launchUrl } : {}),
				...(p.instructions ? { instructions: p.instructions } : {}),
				...(p.message ? { message: p.message } : {}),
			});
		} else if (providerEvent.kind === "provider-prompt") {
			setLoginState(s => ({
				providerId: p.providerId ?? s?.providerId ?? "",
				...(s?.url ? { url: s.url } : {}),
				...(p.message ? { message: p.message } : {}),
				waitingInput: true,
			}));
		} else if (providerEvent.kind === "provider-progress") {
			setLoginState(s => ({
				providerId: s?.providerId ?? "",
				...(s?.url ? { url: s.url } : {}),
				...(p.message ? { message: p.message } : {}),
				...(s?.waitingInput ? { waitingInput: true } : {}),
			}));
		}
	}, [providerEvent]);

	const login = async (providerId: string): Promise<void> => {
		if (!rpc) {
			setError(t("not connected"));
			return;
		}
		setLoginBusy(true);
		setError(null);
		setLoginState({ providerId });
		try {
			const result = await rpc.request<{ ok: boolean }>("providers.login", { providerId });
			if (result?.ok) {
				setLoginState(null);
				await loadProviders();
			}
		} catch (err) {
			setLoginState({ providerId, message: err instanceof Error ? err.message : String(err) });
		} finally {
			setLoginBusy(false);
		}
	};

	const submitLoginInput = async (): Promise<void> => {
		if (!rpc || !loginState) return;
		try {
			await rpc.request("providers.loginInput", { providerId: loginState.providerId, value: promptValue });
			setLoginState(s => (s ? { ...s, waitingInput: false } : s));
			setPromptValue("");
		} catch {
			// daemon rejects — keep the input open
		}
	};

	const cancelLogin = async (): Promise<void> => {
		if (!rpc || !loginState) return;
		try {
			await rpc.request("providers.loginCancel", { providerId: loginState.providerId });
		} catch {
			// ignore
		}
		setLoginState(null);
	};

	const importKey = async (): Promise<void> => {
		if (!rpc || !importTarget) return;
		if (!importValue.trim()) return;
		setImportBusy(true);
		setError(null);
		try {
			await rpc.request("providers.importApiKey", {
				providerId: importTarget.id,
				apiKey: importValue.trim(),
			});
			setImportTarget(null);
			setImportValue("");
			await loadProviders();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setImportBusy(false);
		}
	};

	const submit = async (): Promise<void> => {
		setError(null);
		if (!rpc) {
			setError(t("not connected"));
			return;
		}
		if (!form.name.trim() || !form.baseUrl.trim() || !form.modelId.trim()) {
			setError(t("provider name, base URL and model id are required"));
			return;
		}
		setBusy(true);
		try {
			await rpc.request("models.add", {
				provider: {
					name: form.name.trim(),
					baseUrl: form.baseUrl.trim(),
					...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
					...(form.api !== "openai-completions" ? { api: form.api } : {}),
					models: [{ id: form.modelId.trim(), ...(form.modelName.trim() ? { name: form.modelName.trim() } : {}) }],
				},
			});
			setAdded({ name: form.name.trim() });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const testConnection = async (): Promise<void> => {
		setError(null);
		setTestOk(false);
		if (!rpc) {
			setError(t("not connected"));
			return;
		}
		if (!form.baseUrl.trim() || !form.modelId.trim()) {
			setError(t("provider name, base URL and model id are required"));
			return;
		}
		if (!form.apiKey.trim()) {
			setError(t("api key required to test the connection"));
			return;
		}
		setTesting(true);
		try {
			await rpc.request("providers.testConnection", {
				baseUrl: form.baseUrl.trim(),
				apiKey: form.apiKey.trim(),
				api: form.api,
				modelId: form.modelId.trim(),
			});
			setTestOk(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setTesting(false);
		}
	};

	if (added) {
		return (
			<div className="gui-obo-provider-added" role="status">
				<div className="gui-obo-provider-added-icon">
					<Icon name="check" className="h-5 w-5" />
				</div>
				<div className="gui-obo-provider-added-title">{t("provider added")}</div>
				<div className="gui-obo-provider-added-body">{t("provider added body", { name: added.name })}</div>
			</div>
		);
	}

	const importable = apiProviders.filter(p => !p.configured);

	// Builtin list: all providers (no cap), logged-in first, local search —
	// the API-key import rows join the same scrolled list and filter.
	const [providerQuery, setProviderQuery] = useState("");
	const q = providerQuery.trim().toLowerCase();
	const matchQ = (name: string): boolean => !q || name.toLowerCase().includes(q);
	const visibleBuiltins = (builtins ?? [])
		.filter(p => matchQ(p.name))
		.sort(
			(a, b) => Number(b.loggedIn) - Number(a.loggedIn) || a.name.localeCompare(b.name, "zh"),
		);
	const visibleImportable = importable
		.filter(p => matchQ(p.name))
		.sort((a, b) => a.name.localeCompare(b.name, "zh"));

	return (
		<div className="gui-obo-provider-form">
			<div className="gui-obo-tabs">
				<button
					type="button"
					className={`gui-obo-tab${tab === "builtin" ? " gui-obo-tab--active" : ""}`}
					onClick={() => {
						tapFeedback();
						setTab("builtin");
					}}
				>
					{t("onboarding builtin")}
				</button>
				<button
					type="button"
					className={`gui-obo-tab${tab === "custom" ? " gui-obo-tab--active" : ""}`}
					onClick={() => {
						tapFeedback();
						setTab("custom");
					}}
				>
					{t("onboarding custom")}
				</button>
			</div>

			{tab === "builtin" ? (
				<div className="gui-obo-builtin">
					<div className="gui-obo-search">
						<Icon name="search" className="h-3.5 w-3.5" />
						<input
							className="gui-input"
							placeholder={t("search providers")}
							value={providerQuery}
							onChange={e => setProviderQuery(e.target.value)}
						/>
					</div>
					<div className="gui-obo-provider-scroll">
						{visibleBuiltins.map(p => (
							<div key={p.id} className="gui-obo-provider-row">
								<span className="gui-obo-provider-name">{p.name}</span>
								{p.loggedIn ? (
									<span className="gui-obo-provider-status">
										<Icon name="check" className="h-3.5 w-3.5" />
										{t("logged in")}
									</span>
								) : (
									<button
										type="button"
										className="gui-btn gui-obo-provider-login"
										disabled={loginBusy}
										onClick={() => void login(p.id)}
									>
										{t("login")}
									</button>
								)}
							</div>
						))}
						{visibleImportable.length > 0 && (
							<div className="gui-obo-quick-label gui-obo-import-label">{t("api key import")}</div>
						)}
						{visibleImportable.map(p => (
							<div key={p.id} className="gui-obo-provider-row">
								<span className="gui-obo-provider-name">{p.name}</span>
								<button
									type="button"
									className="gui-btn gui-obo-provider-login"
									onClick={() => {
										setError(null);
										setImportTarget(p);
									}}
								>
									{t("import api key")}
								</button>
							</div>
						))}
						{visibleBuiltins.length === 0 && visibleImportable.length === 0 && (
							<div className="gui-obo-provider-empty">
								{q ? t("no matching providers") : t("no models available")}
							</div>
						)}
					</div>
					{importTarget && (
						<div className="gui-obo-inline-edit">
							<input
								className="gui-input"
								placeholder="sk-…"
								type="password"
								value={importValue}
								onChange={e => setImportValue(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter" && importValue.trim() && !importBusy) void importKey();
								}}
								autoFocus
							/>
							<div className="flex gap-2">
								<button
									type="button"
									className="gui-btn gui-btn-approve"
									disabled={importBusy || !importValue.trim()}
									onClick={() => void importKey()}
								>
									{importBusy ? `${t("saving")}…` : t("import api key")}
								</button>
								<button type="button" className="gui-btn gui-btn-ghost" onClick={() => setImportTarget(null)}>
									{t("cancel")}
								</button>
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="gui-obo-custom">
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
										setForm(v => ({ ...v, name: qp.name, baseUrl: qp.baseUrl }));
									}}
								>
									{qp.name}
								</button>
							))}
						</div>
					</div>
					<input
						className="gui-input"
						placeholder={t("provider name")}
						value={form.name}
						onChange={e => setForm(v => ({ ...v, name: e.target.value }))}
					/>
					<input
						className="gui-input"
						placeholder={URL_HINTS[form.api] ?? "https://api.example.com/v1"}
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
					<select
						className="gui-input"
						value={form.api}
						onChange={e => setForm(v => ({ ...v, api: e.target.value }))}
					>
						<option value="openai-completions">openai</option>
						<option value="openai-responses">openai responses</option>
						<option value="anthropic-messages">anthropic</option>
						<option value="google-generative-ai">google</option>
					</select>
					{error && <div className="gui-obo-provider-error">{error}</div>}
					<div className="flex gap-2">
						<button
							type="button"
							className="gui-btn gui-btn-approve gui-obo-provider-submit"
							disabled={busy}
							onClick={() => void submit()}
						>
							{busy ? `${t("saving")}…` : t("add provider")}
						</button>
						<button
							type="button"
							className="gui-btn gui-obo-test"
							disabled={testing}
							onClick={() => void testConnection()}
						>
							{testing ? `${t("testing")}…` : t("test connection")}
						</button>
						{testOk && (
							<span className="gui-obo-test-ok">
								<Icon name="check" className="h-3.5 w-3.5" />
								{t("connection ok")}
							</span>
						)}
					</div>
				</div>
			)}

			{loginState && (
				<div className="gui-obo-login" role="dialog">
					<div className="gui-obo-login-title">{t("authorize in browser")}</div>
					{loginState.url && (
						<div className="gui-obo-login-row">
							<a href={loginState.url} target="_blank" rel="noreferrer" className="gui-obo-login-url">
								{loginState.url}
							</a>
							<button
								type="button"
								className="gui-obo-login-copy"
								onClick={() => {
									void navigator.clipboard.writeText(loginState.url ?? "").catch(() => {});
									setCopied(true);
									window.setTimeout(() => setCopied(false), 1500);
								}}
							>
								{copied ? t("link copied") : t("copy link")}
							</button>
						</div>
					)}
					{loginState.instructions && <div className="gui-obo-login-msg">{loginState.instructions}</div>}
					{loginState.message && <div className="gui-obo-login-msg">{loginState.message}</div>}
					{loginState.waitingInput ? (
						<>
							<input
								className="gui-input"
								placeholder={t("paste verification code")}
								value={promptValue}
								onChange={e => setPromptValue(e.target.value)}
								onKeyDown={e => {
									if (e.key === "Enter" && promptValue.trim()) void submitLoginInput();
								}}
								autoFocus
							/>
							<div className="flex gap-2">
								<button
									type="button"
									className="gui-btn gui-btn-approve"
									disabled={!promptValue.trim()}
									onClick={() => void submitLoginInput()}
								>
									{t("confirm login")}
								</button>
								<button type="button" className="gui-btn gui-btn-ghost" onClick={() => void cancelLogin()}>
									{t("cancel")}
								</button>
							</div>
						</>
					) : (
						<div className="flex gap-2">
							<button
								type="button"
								className="gui-btn gui-btn-approve"
								onClick={() => {
									setLoginState(null);
									void loadProviders();
								}}
							>
								{t("authorization done")}
							</button>
							<button type="button" className="gui-btn gui-btn-ghost" onClick={() => void cancelLogin()}>
								{t("cancel")}
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** Step 1 — language (first page: welcome + language). */
function LanguageSetup(): ReactNode {
	const [locale, setLocaleState] = useState<string | null>(null);

	useEffect(() => {
		try {
			setLocaleState(localStorage.getItem("omp.collab.locale"));
		} catch {
			// ignore
		}
	}, []);

	const applyLocale = (next: string): void => {
		setLocaleState(next);
		try {
			localStorage.setItem("omp.collab.locale", next);
		} catch {
			// ignore
		}
		setLocale(next);
	};

	return (
		<div className="gui-obo-appearance">
			<div className="gui-obo-appearance-group">
				<span className="gui-obo-quick-label">{t("language")}</span>
				<div className="gui-obo-appearance-options">
					<button
						type="button"
						className={`gui-obo-appearance-card${locale !== "en-US" ? " gui-obo-appearance-card--active" : ""}`}
						onClick={() => {
							tapFeedback();
							applyLocale("zh-CN");
						}}
					>
						<span className="gui-obo-appearance-lang">中文</span>
					</button>
					<button
						type="button"
						className={`gui-obo-appearance-card${locale === "en-US" ? " gui-obo-appearance-card--active" : ""}`}
						onClick={() => {
							tapFeedback();
							applyLocale("en-US");
						}}
					>
						<span className="gui-obo-appearance-lang">English</span>
					</button>
				</div>
			</div>
		</div>
	);
}

const THEME_OPTIONS = [
	{ id: "dark", key: "dark" },
	{ id: "light", key: "light" },
	{ id: "system", key: "follow system" },
] as const;

const ACCENT_OPTIONS = [
	{ id: "brand", key: "accent brand" },
	{ id: "mono", key: "accent mono" },
	{ id: "ocean", key: "accent ocean" },
	{ id: "jade", key: "accent jade" },
	{ id: "custom", key: "custom accent" },
] as const;

/** Step 2 — appearance: theme (dark/light/system) + accent (brand/mono/
 *  ocean/jade + custom), applied live through collab-web's theme module so
 *  the data-theme × data-color-scheme × data-ui-theme × data-accent axes all
 *  stay in sync (same path as the settings toggle). The right-pane window
 *  preview recolors through the same CSS vars. */
function AppearanceSetup(): ReactNode {
	const { preference, setPreference } = useThemePreference();
	const { accent, setAccent, customAccent, applyCustomAccent } = useAccentPreference();
	// Custom-accent picker popover (same app-styled panel as the settings).
	// No className — the panel root owns the card surface (see SettingsView).
	// Preview-first: opening snapshots the preference; edits stay local;
	// 「应用」 applies (veil); closing discards.
	const [pickerOpen, setPickerOpen] = useState(false);
	const [pickerPreview, setPickerPreview] = useState<string | null>(null);
	const { anchorRef: customAccentRef, renderMenu: renderAccentMenu } = useFloatingMenu(pickerOpen, setPickerOpen);

	return (
		<div className="gui-obo-appearance">
			<div className="gui-obo-appearance-group">
				<span className="gui-obo-quick-label">{t("theme")}</span>
				<div className="gui-obo-appearance-options">
					{THEME_OPTIONS.map(opt => (
						<button
							type="button"
							key={opt.id}
							className={`gui-obo-appearance-card${preference === opt.id ? " gui-obo-appearance-card--active" : ""}`}
							onClick={() => {
								tapFeedback();
								setPreference(opt.id);
							}}
						>
							<span className="gui-obo-appearance-lang">{t(opt.key)}</span>
						</button>
					))}
				</div>
			</div>
			<div className="gui-obo-appearance-group">
				<span className="gui-obo-quick-label">{t("accent color")}</span>
				<div className="gui-obo-appearance-options">
					{ACCENT_OPTIONS.map(opt => {
						const isCustom = opt.id === "custom";
						return (
							<button
								type="button"
								key={opt.id}
								ref={isCustom ? customAccentRef : undefined}
								className={`gui-obo-appearance-card${accent === opt.id ? " gui-obo-appearance-card--active" : ""}`}
								onClick={() => {
									tapFeedback();
									if (isCustom) {
										// Open only — no accent switch, no veil; the
										// card edits a local preview, apply happens via
										// the card buttons (settings parity).
										setPickerPreview(customAccent);
										setPickerOpen(true);
									} else {
										setAccent(opt.id);
									}
								}}
							>
								{isCustom ? (
									<span className="gui-obo-accent-swatch" style={{ background: customAccent }} />
								) : (
									<span className="gui-obo-accent-swatch" data-accent={opt.id} />
								)}
								<span>{t(opt.key)}</span>
							</button>
						);
					})}
				</div>
			</div>
			{renderAccentMenu(
				<ColorPickerPanel value={pickerPreview ?? customAccent} onChange={setPickerPreview} onApply={applyCustomAccent} />,
			)}
		</div>
	);
}

export function OnboardingOverlay({
	rpc,
	providerEvent,
}: {
	rpc: RpcClient | null;
	providerEvent: StreamEvent | null;
}): ReactNode {
	const [open, setOpen] = useState(onboardingPending);
	const [step, setStep] = useState(0);
	// Pet display mode shared by the personalize step's controls (left) and
	// the chat preview (right): "desktop" hides the pet from the preview's
	// composer — it lives in its own desktop window there.
	const [persPetMode, setPersPetMode] = useState<"input" | "desktop">(() => {
		try {
			return localStorage.getItem("omp-gui-pet-mode") === "desktop" ? "desktop" : "input";
		} catch {
			return "input";
		}
	});
	// Stay mounted through the exit (Pop/DialogFrame parity): closing plays
	// the fade-out before unmounting, so close animates instead of cutting.
	const [closing, setClosing] = useState(false);
	// Two-phase enter: the 24px frosted backdrop paints at opacity 0 first
	// so it composites before gui-fade-in (mount-frame animation on a
	// backdrop-filter element kills the frost — gui-implementation.md §6.5).
	const enteredCls = useTwoPhaseEnter(open);

	const requestClose = useCallback((): void => {
		setClosing(true);
		setTimeout(() => {
			setOpen(false);
			setClosing(false);
		}, ONBOARDING_EXIT_MS);
	}, []);

	// Settings footer 引导 button reopens the primer on demand.
	useEffect(() => {
		const onOpen = (): void => {
			setStep(0);
			setClosing(false);
			setOpen(true);
		};
		window.addEventListener("omp-open-onboarding", onOpen);
		return () => window.removeEventListener("omp-open-onboarding", onOpen);
	}, []);

	const finish = useCallback((): void => {
		try {
			localStorage.setItem(DONE_KEY, "1");
		} catch {
			// ignore
		}
		requestClose();
		// First-run flow continues into the what's-new announcement when one
		// is pending (AnnouncementOverlay listens for this) — after the exit
		// animation, so the announcement fades in over the settled screen.
		setTimeout(() => window.dispatchEvent(new CustomEvent("omp-onboarding-finished")), ONBOARDING_EXIT_MS + 40);
	}, [requestClose]);

	// Keyboard priority: while the primer is up, Enter advances (next step /
	// finish) and Escape steps back / closes on the first step — the page
	// behind (composer) must not swallow them. Inputs keep their own Enter
	// (import key / login prompt), so the handler skips text fields. The
	// panel is focused on open so keys land on it.
	useEffect(() => {
		if (!open) return;
		const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const onKey = (e: KeyboardEvent): void => {
			const t = e.target as HTMLElement | null;
			const typing =
				t &&
				(t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
			if (e.key === "Enter" && !typing) {
				e.preventDefault();
				e.stopPropagation();
				if (step === STEPS.length - 1) finish();
				else setStep(s => Math.min(s + 1, STEPS.length - 1));
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (step > 0) setStep(s => s - 1);
				else requestClose();
			}
		};
		document.addEventListener("keydown", onKey, true);
		const raf = requestAnimationFrame(() => {
			document.querySelector<HTMLElement>(".gui-onboarding-backdrop button")?.focus();
		});
		return () => {
			document.removeEventListener("keydown", onKey, true);
			cancelAnimationFrame(raf);
			prevActive?.focus();
		};
	}, [open, step, finish, requestClose]);

	if (!open) return null;
	const current = STEPS[step];
	const last = step === STEPS.length - 1;
	return (
		<div
			className={`gui-onboarding-backdrop${enteredCls ? " gui-onboarding-backdrop--entered" : ""}${
				closing ? " gui-onboarding-backdrop--closing" : ""
			}`}
		>
			<div className={`gui-onboarding-card${closing ? " gui-onboarding-card--closing" : ""}`}>
				<div className="gui-onboarding-topbar">
					<span className="gui-onboarding-badge">{t("onboarding badge")}</span>
					<button
						type="button"
						className="gui-onboarding-close"
						aria-label={t("close")}
						onClick={() => {
							tapFeedback();
							finish();
						}}
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
				<div className="gui-onboarding-grid">
					{/* NOTE: the pane itself must NOT remount on step change —
					 * key={step} would unmount MorphIcon and kill the morph
					 * transition (icon snaps). Children that need re-entry
					 * animations carry their own step keys. */}
					<div className="gui-onboarding-pane">
						<div className="gui-onboarding-icon">
							<MorphIcon icon={current.icon} size={30} spring="snappy" />
						</div>
						<div className="gui-onboarding-title" key={`title-${step}`}>
							{t("onboarding title")}
						</div>
						<div className="gui-onboarding-body" key={`body-${step}`}>
							{t(current.key)}
						</div>
						{/* Step content scrolls inside the pane (provider config and
						 * personalization are tall); dots + actions stay pinned. */}
						<div className="gui-obo-step-body">
							{step >= 2 && step <= 4 && (
								<FeatureList
									key={`feat-${step}`}
									keys={PROMO_FEATURES[current.key as keyof typeof PROMO_FEATURES] ?? []}
								/>
							)}
							{step === 0 && <LanguageSetup />}
							{step === 1 && <AppearanceSetup />}
							{step === 5 && <ProviderSetup rpc={rpc} providerEvent={providerEvent} />}
							{step === 6 && <PersonalizeSetup rpc={rpc} petMode={persPetMode} onPetModeChange={setPersPetMode} />}
						</div>
						<div className="gui-onboarding-dots">
							{STEPS.map((s, i) => (
								<span
									key={s.key}
									className={`gui-onboarding-dot${i === step ? " gui-onboarding-dot--active" : ""}`}
								/>
							))}
						</div>
						<div className="gui-onboarding-actions">
							{step > 0 && (
								<button
									type="button"
									className="gui-btn gui-btn-ghost"
									onClick={() => {
										tapFeedback();
										setStep(s => s - 1);
									}}
								>
									{t("back")}
								</button>
							)}
							<button
								type="button"
								className="gui-btn gui-btn-primary gui-onboarding-next"
								onClick={() => {
									tapFeedback();
									if (!last) setStep(s => s + 1);
									else finish();
								}}
							>
								<span>{last ? t("get started") : t("next")}</span>
								<Icon name="arrow-right" className="h-4 w-4" />
							</button>
						</div>
					</div>
					<div className="gui-onboarding-visual">
						<StepDemo step={step} petMode={persPetMode} />
					</div>
				</div>
			</div>
		</div>
	);
}
