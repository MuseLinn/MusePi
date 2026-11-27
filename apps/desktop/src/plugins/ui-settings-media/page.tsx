/**
 * MediaSection — settings section for image & video generation providers.
 *
 * The list is the daemon's (`media.providers`): the built-in image providers,
 * the built-in video providers and any extension-registered media providers,
 * each with its credential state. The daemon also says HOW a provider stores
 * its credential (`authType`), so this page offers the right control instead
 * of guessing: an API-key field, a login button, or both.
 *
 * Credential writes reuse the provider-scoped RPCs (providers.importApiKey /
 * providers.login / providers.logout) — the same store the model providers use,
 * so a key entered here is visible to generate_image immediately and a key
 * added under 模型与供应商 shows up here.
 */
import { type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Reveal } from "../../components/Reveal";
import { reportRequestFailure } from "../../lib/report-request-failure";
import { logoutProvider } from "../../lib/rpc-commands";
import type { SlotComponentProps } from "../../lib/slot-host";
import { useProviderCatalog, useProviderEvents } from "../../lib/use-provider-catalog";
import { Icon } from "../../vendor/oc-icons";

interface MediaProviderEntry {
	id: string;
	label: string;
	kind: "image" | "video";
	source: "builtin" | "extension";
	configured: boolean;
	description?: string;
	baseUrl?: string | null;
	models?: string[];
	/** How the credential is stored. Built-ins used to omit it, which made the
	 *  client render a login button for key-only providers. */
	authType?: "apiKey" | "oauth" | "both";
}

/** Settings style secret input — standard gui-settings-select text input. */
function SecretInput({
	value,
	onChange,
	placeholder,
	label,
}: {
	value: string;
	onChange(v: string): void;
	placeholder?: string;
	label: string;
}): ReactNode {
	return (
		<input
			type="password"
			spellCheck={false}
			className="gui-settings-select !w-auto min-w-[200px] max-w-[300px] font-mono text-[12px]"
			placeholder={placeholder ?? "sk-..."}
			aria-label={label}
			value={value}
			onInput={e => onChange((e.target as HTMLInputElement).value)}
		/>
	);
}

/** User-facing provider copy, one line per built-in id. The daemon's
 *  description is written for the tool ("Requires AGNES_API_KEY"); the
 *  settings page says what the provider is and what it needs in the reader's
 *  language. Extension providers keep the description their author wrote. */
const PROVIDER_DESCRIPTION: Record<string, TranslationKey> = {
	agnes: "settings.mediaProvider.agnes",
	"agnes-global": "settings.mediaProvider.agnesGlobal",
	openai: "settings.mediaProvider.openai",
	"openai-codex": "settings.mediaProvider.openaiCodex",
	antigravity: "settings.mediaProvider.antigravity",
	xai: "settings.mediaProvider.xai",
	gemini: "settings.mediaProvider.gemini",
	openrouter: "settings.mediaProvider.openrouter",
	minimax: "settings.mediaProvider.minimax",
	meta: "settings.mediaProvider.meta",
};

function descriptionFor(provider: MediaProviderEntry): string {
	const key = PROVIDER_DESCRIPTION[provider.id];
	return key ? t(key) : (provider.description ?? "");
}

function configuredFirst(a: MediaProviderEntry, b: MediaProviderEntry): number {
	if (a.configured !== b.configured) return a.configured ? -1 : 1;
	return a.label.localeCompare(b.label);
}

/** One provider: identity, one-line explanation, status, and the credential
 *  control that matches its auth type. */
function MediaProviderRow({
	provider,
	apiKey,
	onApiKeyChange,
	onSave,
	onRemove,
	onLogin,
	busy,
	pendingLogin,
}: {
	provider: MediaProviderEntry;
	apiKey: string;
	onApiKeyChange(v: string): void;
	onSave(): void;
	onRemove(): void;
	onLogin?(): void;
	busy: boolean;
	pendingLogin: boolean;
}): ReactNode {
	const [keyOpen, setKeyOpen] = useState(false);
	const auth = provider.authType ?? "apiKey";
	const canKey = auth !== "oauth";
	const canLogin = auth !== "apiKey" && Boolean(onLogin);
	const configured = provider.configured;
	const description = descriptionFor(provider);
	const mark = provider.label.trim().charAt(0).toUpperCase() || "?";

	return (
		<div className={`gui-media-provider${configured ? " gui-media-provider--on" : ""}`}>
			<div className="gui-media-provider-main">
				<span className="gui-media-provider-mark" aria-hidden="true">
					{mark}
				</span>
				<div className="gui-media-provider-copy">
					<div className="gui-media-provider-name">
						<span>{provider.label}</span>
						{provider.source === "extension" && (
							<span className="gui-provider-chip">{t("settings.mediaProviderExtension")}</span>
						)}
						{provider.models && provider.models.length > 0 && (
							<span className="gui-provider-chip">{provider.models.join(" · ")}</span>
						)}
					</div>
					{description && <div className="gui-media-provider-desc">{description}</div>}
				</div>
				<div className="gui-media-provider-side">
					<span className={`gui-media-status${configured ? " gui-media-status--on" : ""}`}>
						<span
							className={`gui-provider-status-dot${configured ? " gui-provider-status-dot--on" : ""}`}
							aria-hidden="true"
						/>
						{configured ? t("settings.configured") : t("settings.notConfigured")}
					</span>
					{configured ? (
						<button
							type="button"
							className="gui-media-remove"
							disabled={busy}
							title={t("general.removeCredential")}
							aria-label={t("settings.removeCredentialFor", { provider: provider.label })}
							onClick={onRemove}
						>
							<Icon name="delete-bin" className="h-3.5 w-3.5" />
						</button>
					) : (
						<>
							{canKey && (
								<button
									type="button"
									className="gui-btn gui-media-action"
									aria-expanded={keyOpen}
									onClick={() => setKeyOpen(open => !open)}
								>
									{t("settings.addApiKey")}
								</button>
							)}
							{canLogin && (
								<button
									type="button"
									className="gui-btn gui-btn-approve gui-media-login"
									disabled={busy || pendingLogin}
									onClick={onLogin}
								>
									<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
									{pendingLogin ? t("settings.loggingIn") : t("settings.login")}
								</button>
							)}
						</>
					)}
				</div>
			</div>

			{!configured && canKey && (
				<Reveal open={keyOpen}>
					<div className="gui-media-keyrow">
						<SecretInput
							value={apiKey}
							onChange={onApiKeyChange}
							placeholder={t("settings.enterApiKey")}
							label={t("settings.apiKeyFor", { provider: provider.label })}
						/>
						<button
							type="button"
							className="gui-btn gui-btn-approve"
							disabled={busy || !apiKey.trim()}
							onClick={onSave}
						>
							{t("general.save")}
						</button>
					</div>
				</Reveal>
			)}
			{!configured && !canKey && !canLogin && (
				<div className="gui-media-provider-foot">{t("settings.oauthProviderManageProviders")}</div>
			)}
		</div>
	);
}

/** A titled run of provider rows with a count; the note stays under the list
 *  it explains. */
function MediaProviderGroup({
	title,
	providers,
	note,
	empty,
	...rowProps
}: {
	title: string;
	providers: MediaProviderEntry[];
	note?: string;
	empty: string;
	apiKeys: Record<string, string>;
	onApiKeyChange(id: string, value: string): void;
	onSave(id: string): void;
	onRemove(id: string): void;
	onLogin?(id: string): void;
	busy: boolean;
	pendingLogins?: readonly string[];
}): ReactNode {
	const { apiKeys, onApiKeyChange, onSave, onRemove, onLogin, busy, pendingLogins } = rowProps;
	return (
		<div className="gui-media-group">
			<div className="gui-media-group-head">
				<span className="gui-media-group-title">{title}</span>
				{providers.length > 0 && <span className="gui-media-group-count">{providers.length}</span>}
			</div>
			{providers.length === 0 ? (
				<div className="gui-media-empty">{empty}</div>
			) : (
				<div className="gui-media-list">
					{providers.map(provider => (
						<MediaProviderRow
							key={provider.id}
							provider={provider}
							apiKey={apiKeys[provider.id] ?? ""}
							onApiKeyChange={v => onApiKeyChange(provider.id, v)}
							onSave={() => onSave(provider.id)}
							onRemove={() => onRemove(provider.id)}
							onLogin={onLogin ? () => onLogin(provider.id) : undefined}
							busy={busy}
							pendingLogin={pendingLogins?.includes(provider.id) ?? false}
						/>
					))}
				</div>
			)}
			{note && <p className="gui-media-group-note">{note}</p>}
		</div>
	);
}

export default function MediaSettingsPage({ rpc }: SlotComponentProps): ReactNode {
	// The catalog and the login flows come from the shared hook, so this page owns
	// no copy of them and the host threads no callbacks in. The daemon's auth
	// envelopes are subscribed here because the page is mounted on its own.
	const providerEvent = useProviderEvents(rpc ?? null);
	const { login, pendingLogins } = useProviderCatalog({ rpc: rpc ?? null, sessionId: null, providerEvent });
	const [providers, setProviders] = useState<{
		builtin: MediaProviderEntry[];
		extension: MediaProviderEntry[];
	} | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	/** Per-provider unsaved API key input state. */
	const [apiKeys, setApiKeys] = useState<Record<string, string>>({});

	const load = useRef(() => {});
	load.current = () => {
		if (!rpc) return;
		void rpc
			.request<{ builtin: MediaProviderEntry[]; extension: MediaProviderEntry[] }>("media.providers", {})
			.then(res => {
				setProviders(res);
				setError(null);
			})
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
	};
	useEffect(() => load.current(), [rpc]);

	const importKey = async (id: string): Promise<void> => {
		const key = apiKeys[id];
		if (!rpc || !key?.trim()) return;
		setBusy(true);
		try {
			await rpc.request("providers.importApiKey", { providerId: id, apiKey: key.trim() });
			setApiKeys(prev => ({ ...prev, [id]: "" }));
			load.current();
		} catch (err) {
			// The key was not stored; the row would look unchanged for no reason.
			reportRequestFailure(t("general.importApiKey"), err);
		} finally {
			setBusy(false);
		}
	};

	const removeCredential = async (id: string): Promise<void> => {
		if (!rpc) return;
		setBusy(true);
		try {
			await logoutProvider(rpc, { providerId: id });
			load.current();
		} catch (err) {
			// The key is still stored; the row would look cleared for no reason.
			reportRequestFailure(t("settings.logout"), err);
		} finally {
			setBusy(false);
		}
	};

	if (error) {
		return (
			<>
				<h2 className="gui-settings-page-title">{t("settings.imageVideoGeneration")}</h2>
				<p className="text-[var(--color-warning)] text-[13px]">{error}</p>
			</>
		);
	}
	if (!providers) return null;

	const imageProviders = [
		...providers.builtin.filter(p => p.kind === "image"),
		...providers.extension.filter(p => p.kind === "image"),
	].sort(configuredFirst);
	const videoProviders = [
		...providers.builtin.filter(p => p.kind === "video"),
		...providers.extension.filter(p => p.kind === "video"),
	].sort(configuredFirst);

	const rowProps = {
		apiKeys,
		onApiKeyChange: (id: string, value: string) => setApiKeys(prev => ({ ...prev, [id]: value })),
		onSave: (id: string) => void importKey(id),
		onRemove: (id: string) => void removeCredential(id),
		onLogin: login,
		busy,
		pendingLogins,
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.imageVideoGeneration")}</h2>
			<p className="gui-settings-page-subtitle">{t("settings.imageVideoGenSubtitle")}</p>

			<MediaProviderGroup
				title={t("settings.imageGenerationProviders")}
				providers={imageProviders}
				empty={t("settings.noImageProvidersAvailable")}
				{...rowProps}
			/>
			<MediaProviderGroup
				title={t("settings.videoGenerationProviders")}
				providers={videoProviders}
				empty={t("settings.noVideoProvidersAvailable")}
				note={t("settings.videoGenNote")}
				{...rowProps}
			/>
		</>
	);
}
