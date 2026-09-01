/**
 * MediaSection — settings section for image & video generation providers.
 * Shows the 8 built-in image providers + any extension-registered media
 * providers with per-provider credential status, API key entry for apiKey-
 * typed providers, and OAuth login for oauth-typed providers.
 *
 * Credential writes use the same provider-scoped RPCs as the ModelSection
 * providers tab (providers.importApiKey / providers.login / providers.logout),
 * so a key entered here is visible to the generate_image tool immediately.
 */
import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
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
	authType?: string;
}

/** Settings style secret input — standard gui-settings-select text input.
 *  state kept as controlled component via the parent's apiKey state map. */
function SecretInput({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange(v: string): void;
	placeholder?: string;
}): ReactNode {
	return (
		<input
			type="password"
			spellCheck={false}
			className="gui-settings-select !w-auto min-w-[180px] max-w-[280px] font-mono text-[12px]"
			placeholder={placeholder ?? "sk-..."}
			value={value}
			onInput={e => onChange((e.target as HTMLInputElement).value)}
		/>
	);
}

export function MediaSection({
	rpc,
	onLogin,
	pendingLogins,
}: {
	rpc: RpcClient | null;
	/** Optional OAuth login handler, same as ModelSection's onLogin — when
	 *  absent (or for providers without onLogin), the section shows a "manage
	 *  in providers tab" hint for oauth providers instead. */
	onLogin?: (providerId: string) => void;
	pendingLogins?: readonly string[];
}): ReactNode {
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
		} catch {
			// daemon error is non-fatal
		} finally {
			setBusy(false);
		}
	};

	const removeCredential = async (id: string): Promise<void> => {
		if (!rpc) return;
		setBusy(true);
		try {
			await rpc.request("providers.logout", { providerId: id });
			load.current();
		} catch {
			// non-fatal
		} finally {
			setBusy(false);
		}
	};

	if (error) {
		return (
			<>
				<h2 className="gui-settings-page-title">{t("image & video generation")}</h2>
				<p className="text-[var(--color-warning)] text-[13px]">{error}</p>
			</>
		);
	}
	if (!providers) return null;

	const imageProviders = [
		...providers.builtin.filter(p => p.kind === "image"),
		...providers.extension.filter(p => p.kind === "image"),
	];
	const videoProviders = [
		...providers.builtin.filter(p => p.kind === "video"),
		...providers.extension.filter(p => p.kind === "video"),
	];

	return (
		<>
			<h2 className="gui-settings-page-title">{t("image & video generation")}</h2>
			<p className="gui-settings-page-subtitle">{t("image & video gen subtitle")}</p>

			{/* Image generation providers */}
			<h3 className="gui-settings-card-title">{t("image generation providers")}</h3>
			<div className="gui-settings-card-grid">
				{imageProviders.length === 0 && (
					<p className="text-[13px] text-[var(--color-text-muted)]">{t("no image providers available")}</p>
				)}
				{imageProviders.map(p => (
					<div key={p.id} className="gui-settings-section mb-2">
						<div className="gui-settings-row">
							<div className="min-w-0 flex-1">
								<div className="gui-settings-row-label">{p.label}</div>
								{p.description && (
									<div className="truncate text-[12px] text-[var(--color-text-faint)]">{p.description}</div>
								)}
							</div>
							<span
								className={`gui-provider-status-dot${p.configured ? " gui-provider-status-dot--on" : ""}`}
								aria-hidden="true"
							/>
							<span className="text-[12px] text-[var(--color-text-muted)]">
								{p.configured ? t("configured") : t("not configured")}
							</span>
						</div>
						{p.source === "extension" && p.models && p.models.length > 0 && (
							<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">
								<span className="font-medium">{t("models")}:</span>
								<span>{p.models.join(", ")}</span>
							</div>
						)}
						{!p.configured && (
							<div className="gui-settings-row">
								{p.authType === "oauth" || !p.authType ? (
									onLogin ? (
										<button
											type="button"
											className="gui-btn gui-btn-approve"
											disabled={pendingLogins?.includes(p.id)}
											onClick={() => onLogin(p.id)}
										>
											<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
											{t("login")}
										</button>
									) : (
										<span className="text-[12px] text-[var(--color-text-muted)]">
											{t("oauth provider — manage in providers tab")}
										</span>
									)
								) : (
									<div className="flex items-center gap-2">
										<SecretInput
											value={apiKeys[p.id] ?? ""}
											onChange={v => setApiKeys(prev => ({ ...prev, [p.id]: v }))}
											placeholder={t("enter api key")}
										/>
										<button
											type="button"
											className="gui-btn gui-btn-approve"
											disabled={busy || !(apiKeys[p.id] ?? "").trim()}
											onClick={() => void importKey(p.id)}
										>
											{t("save")}
										</button>
									</div>
								)}
							</div>
						)}
						{p.configured && (
							<div className="gui-settings-row">
								<button
									type="button"
									className="gui-btn"
									disabled={busy}
									onClick={() => void removeCredential(p.id)}
								>
									<Icon name="delete-bin" className="h-3.5 w-3.5" />
									{t("remove credential")}
								</button>
							</div>
						)}
					</div>
				))}
			</div>

			{/* Video generation */}
			{videoProviders.length > 0 && (
				<>
					<h3 className="gui-settings-card-title mt-4">{t("video generation providers")}</h3>
					{videoProviders.map(p => (
						<div key={p.id} className="gui-settings-section mb-2">
							<div className="gui-settings-row">
								<div className="min-w-0 flex-1">
									<div className="gui-settings-row-label">{p.label}</div>
								</div>
								<span
									className={`gui-provider-status-dot${p.configured ? " gui-provider-status-dot--on" : ""}`}
									aria-hidden="true"
								/>
								<span className="text-[12px] text-[var(--color-text-muted)]">
									{p.configured ? t("configured") : t("not configured")}
								</span>
							</div>
							{!p.configured && (
								<div className="gui-settings-row">
									<div className="flex items-center gap-2">
										<SecretInput
											value={apiKeys[p.id] ?? ""}
											onChange={v => setApiKeys(prev => ({ ...prev, [p.id]: v }))}
											placeholder={t("enter api key")}
										/>
										<button
											type="button"
											className="gui-btn gui-btn-approve"
											disabled={busy || !(apiKeys[p.id] ?? "").trim()}
											onClick={() => void importKey(p.id)}
										>
											{t("save")}
										</button>
									</div>
								</div>
							)}
							{p.configured && (
								<div className="gui-settings-row">
									<button
										type="button"
										className="gui-btn"
										disabled={busy}
										onClick={() => void removeCredential(p.id)}
									>
										<Icon name="delete-bin" className="h-3.5 w-3.5" />
										{t("remove credential")}
									</button>
								</div>
							)}
						</div>
					))}
					<p className="text-[12px] text-[var(--color-text-muted)] mt-1">{t("video gen note")}</p>
				</>
			)}

			{/* Extension providers summary */}
			{providers.extension.length > 0 && (
				<p className="text-[12px] text-[var(--color-text-faint)] mt-3">
					{t("extension providers count", { count: providers.extension.length })}
				</p>
			)}
		</>
	);
}
