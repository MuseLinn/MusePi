/**
 * Settings → 智能体 → 保险库: the agent secret vault.
 *
 * Values are write-only over this page: the daemon returns metadata only
 * (`secret.list`), and every input that accepts a value is a masked field.
 * The page never renders a stored value, offers a reveal toggle, or keeps a
 * value after its form closes. A pasted .env is parsed here and stored as one
 * entry per `NAME=value`; its text is dropped when the form closes.
 *
 * The store is always encrypted with a local per-profile master key, so the
 * page states the fact once in its footnote. The master key itself is either a
 * plain 0600 file or wrapped by a user passphrase; the protection row at the
 * top switches between the two and unlocks a locked store for this process
 * only. `packages/coding-agent/src/secrets/agent-store.ts` writes one
 * AES-256-GCM envelope per name and a metadata sidecar at 0600; a value reaches
 * a bash child as `$MUSEPI_SECRET_<NAME>`, tool output shows `[secret:NAME]`,
 * and the provider boundary carries a keyed placeholder instead of the value.
 */

import { t } from "@musepi/client-core";
import { formatWhen } from "@musepi/client-core/src/lib/format";
import { KeyRound, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import { useConfirm } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";

/** Wire contract for the daemon's `secret.*` methods. Timestamps are epoch ms. */
type SecretScope = "all" | string[];
type SecretDelivery = "env" | "file";

interface SecretEntryView {
	name: string;
	purpose: string;
	scope: SecretScope;
	delivery: SecretDelivery;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
}

interface SecretStatusResult {
	mode: "encrypted";
	count: number;
	/** How the master key is stored: a plain key file, or wrapped by a passphrase. */
	protectedBy?: "key-file" | "passphrase";
	/** A passphrase is required and this daemon process has not unlocked the store. */
	locked?: boolean;
	reason?: "missing-passphrase" | "wrong-passphrase" | "passphrase-source";
	/** The connector token store, which follows the same passphrase as the vault. */
	connectors?: { protectedBy: "key-file" | "passphrase"; locked: boolean };
}

interface SecretListResult {
	entries: SecretEntryView[];
	count: number;
}

/** One configured server as the vault page sees it (`mcp.servers.list`). */
interface McpServerOption {
	name: string;
	target: string;
}

/** A recorded grant (`secret.mcpGrants`). */
interface McpGrant {
	server: string;
	target: string;
	keys: string[];
}

/** Which servers may use one stored key; `checked` holds server names. */
interface GrantFormState {
	entry: SecretEntryView;
	servers: McpServerOption[];
	grants: McpGrant[];
	checked: string[];
}

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MIN_SECRET_VALUE_LENGTH = 4;
const MIN_PASSPHRASE_LENGTH = 8;

interface SecretFormState {
	mode: "add" | "replace";
	name: string;
	purpose: string;
	value: string;
	delivery: SecretDelivery;
}

/** `unlock` opens a locked store; `protect`, `change` and `remove` change how the key is stored. */
type ProtectionMode = "unlock" | "protect" | "change" | "remove";

interface ProtectionState {
	mode: ProtectionMode;
	/** The passphrase typed in the first field: to prove, or the new one when protecting. */
	passphrase: string;
	/** Only for `change`: the replacement passphrase. */
	next: string;
	confirm: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lastUsedText(entry: SecretEntryView): string {
	return entry.lastUsedAt && entry.lastUsedAt > 0
		? t("settings.secretsLastUsed", { when: formatWhen(entry.lastUsedAt) })
		: "";
}

function scopeLabel(scope: SecretScope): string {
	return scope === "all"
		? t("settings.secretsScopeAll")
		: t("settings.secretsScopeWorkspaces", { count: scope.length });
}

function lockedReasonText(reason: SecretStatusResult["reason"]): string {
	switch (reason) {
		case "wrong-passphrase":
			return t("settings.secretsLockedWrong");
		case "passphrase-source":
			return t("settings.secretsLockedSource");
		default:
			return t("settings.secretsLockedMissing");
	}
}

function WarningLine({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
	return (
		<div className="gui-secret-warning">
			<span className="gui-secret-warning-text">{message}</span>
			{onRetry && (
				<button type="button" className="gui-btn gui-btn-ghost gui-btn-icon" onClick={onRetry}>
					<RefreshCw size={12} aria-hidden="true" /> {t("settings.secretsRetry")}
				</button>
			)}
		</div>
	);
}

/** Add and replace share one masked field set; replace keeps the stored name
 *  and purpose so the upsert only touches the value. */
function SecretForm({
	form,
	busy,
	error,
	onChange,
	onCancel,
	onSubmit,
}: {
	form: SecretFormState;
	busy: boolean;
	error: string | null;
	onChange(patch: Partial<SecretFormState>): void;
	onCancel(): void;
	onSubmit(): void;
}): ReactNode {
	return (
		<form
			className="gui-agent-card gui-secret-form"
			data-secret-form={form.mode}
			aria-busy={busy}
			onSubmit={event => {
				event.preventDefault();
				onSubmit();
			}}
			onKeyDown={event => {
				if (event.key !== "Escape" || busy) return;
				event.preventDefault();
				event.stopPropagation();
				onCancel();
			}}
		>
			<div className="gui-secret-form-head">
				<span className="gui-secret-form-title">
					{form.mode === "add" ? t("settings.secretsAddTitle") : t("settings.secretsReplaceTitle")}
				</span>
				{form.mode === "replace" && <span className="gui-secret-name">{form.name}</span>}
			</div>
			{form.mode === "add" && (
				<label className="gui-settings-field">
					<span className="gui-settings-field-label">{t("settings.secretsName")}</span>
					<span className="gui-settings-field-hint">{t("settings.secretsNameHint")}</span>
					<span className="gui-settings-field-control">
						<input
							className="gui-secret-input gui-secret-input--mono"
							data-secret-field="name"
							value={form.name}
							placeholder={t("settings.secretsNamePlaceholder")}
							spellCheck={false}
							autoComplete="off"
							autoFocus
							disabled={busy}
							onChange={event => onChange({ name: event.target.value.toUpperCase() })}
						/>
					</span>
				</label>
			)}
			<label className="gui-settings-field">
				<span className="gui-settings-field-label">{t("settings.secretsValue")}</span>
				<span className="gui-settings-field-hint">{t("settings.secretsValueHint")}</span>
				<span className="gui-settings-field-control">
					<input
						// Masked control; no reveal affordance on this page.
						type="password"
						className="gui-secret-input gui-secret-input--mono"
						data-secret-field="value"
						value={form.value}
						placeholder={t("settings.secretsValuePlaceholder")}
						spellCheck={false}
						autoComplete="new-password"
						autoFocus={form.mode === "replace"}
						disabled={busy}
						onChange={event => onChange({ value: event.target.value })}
					/>
				</span>
			</label>
			{form.mode === "add" && (
				<label className="gui-settings-field">
					<span className="gui-settings-field-label">{t("settings.secretsPurpose")}</span>
					<span className="gui-settings-field-control">
						<input
							className="gui-secret-input"
							data-secret-field="purpose"
							value={form.purpose}
							placeholder={t("settings.secretsPurposePlaceholder")}
							disabled={busy}
							onChange={event => onChange({ purpose: event.target.value })}
						/>
					</span>
				</label>
			)}
			<div className="gui-secret-form-foot">
				<span className="gui-settings-field-hint">
					{t("settings.secretsScope")}: {t("settings.secretsScopeAll")}
				</span>
				<span className="gui-settings-field-hint">
					{t("settings.secretsDelivery")}:{" "}
					{form.delivery === "file" ? t("settings.secretsDeliveryFile") : t("settings.secretsDeliveryEnv")}
				</span>
				<div className="gui-secret-form-actions">
					<button type="button" className="gui-btn" onClick={onCancel} disabled={busy}>
						{t("settings.cancel")}
					</button>
					<button type="submit" className="gui-btn gui-btn-primary" disabled={busy}>
						{busy ? t("settings.secretsSaving") : t("general.save")}
					</button>
				</div>
			</div>
			{error && (
				<div className="gui-secret-form-error" role="alert">
					{error}
				</div>
			)}
		</form>
	);
}

export function SecretSettingsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const { confirm } = useConfirm();
	const [entries, setEntries] = useState<SecretEntryView[]>([]);
	const [status, setStatus] = useState<SecretStatusResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [protection, setProtection] = useState<ProtectionState | null>(null);
	const [protectionBusy, setProtectionBusy] = useState(false);
	const [protectionError, setProtectionError] = useState<string | null>(null);
	const [form, setForm] = useState<SecretFormState | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [widening, setWidening] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [importing, setImporting] = useState(false);
	const [grantForm, setGrantForm] = useState<GrantFormState | null>(null);
	const [grantBusy, setGrantBusy] = useState(false);
	const [grantError, setGrantError] = useState<string | null>(null);
	const [envText, setEnvText] = useState("");
	const [envError, setEnvError] = useState<string | null>(null);
	const [envDone, setEnvDone] = useState<number | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	const reload = useCallback((): void => {
		setReloadToken(token => token + 1);
	}, []);

	useEffect(() => {
		if (!rpc) {
			setEntries([]);
			setStatus(null);
			setLoading(false);
			setStatusError(null);
			setListError(null);
			return;
		}
		let alive = true;
		setLoading(true);
		setStatusError(null);
		setListError(null);
		void Promise.allSettled([
			rpc.request<SecretStatusResult>("secret.status", {}),
			rpc.request<SecretListResult>("secret.list", {}),
		]).then(([statusResult, listResult]) => {
			if (!alive) return;
			if (statusResult.status === "fulfilled") {
				setStatus(statusResult.value ?? null);
			} else {
				// Without a readable status the protection row would guess wrong.
				setStatus(null);
				setStatusError(errorText(statusResult.reason));
			}
			if (listResult.status === "fulfilled") {
				setEntries(Array.isArray(listResult.value?.entries) ? listResult.value.entries : []);
			} else {
				setListError(errorText(listResult.reason));
			}
			setLoading(false);
		});
		return () => {
			alive = false;
		};
	}, [rpc, reloadToken]);

	const openProtection = (mode: ProtectionMode): void => {
		tapFeedback();
		setProtectionError(null);
		setProtection({ mode, passphrase: "", next: "", confirm: "" });
	};

	const closeProtection = (): void => {
		setProtection(null);
		setProtectionError(null);
	};

	/**
	 * Read both halves the form needs: the servers this machine has, and the
	 * grants already recorded. A box is checked only when the stored grant
	 * names the same endpoint, so a moved server shows unchecked.
	 */
	const openGrant = async (entry: SecretEntryView): Promise<void> => {
		if (!rpc || grantBusy) return;
		tapFeedback();
		setActionError(null);
		setGrantError(null);
		setGrantBusy(true);
		try {
			const [configured, recorded] = await Promise.all([
				rpc.request<{ servers?: McpServerOption[] }>("mcp.servers.list", {}),
				rpc.request<{ servers?: McpGrant[] }>("secret.mcpGrants", {}),
			]);
			const servers = (Array.isArray(configured?.servers) ? configured.servers : []).filter(
				(server): server is McpServerOption =>
					typeof server?.name === "string" && typeof server?.target === "string",
			);
			const grants = Array.isArray(recorded?.servers) ? recorded.servers : [];
			const checked = servers
				.filter(server =>
					grants.some(
						grant =>
							grant.server === server.name && grant.target === server.target && grant.keys.includes(entry.name),
					),
				)
				.map(server => server.name);
			setGrantForm({ entry, servers, grants, checked });
		} catch (error) {
			setActionError(t("settings.secretsMcpLoadFailed", { error: errorText(error) }));
		} finally {
			setGrantBusy(false);
		}
	};

	const toggleGrant = (server: string, allowed: boolean): void => {
		setGrantError(null);
		setGrantForm(current => {
			if (!current) return current;
			const checked = allowed
				? [...current.checked.filter(name => name !== server), server]
				: current.checked.filter(name => name !== server);
			return { ...current, checked };
		});
	};

	/** Write only the servers whose key set for this secret actually changed. */
	const saveGrant = async (): Promise<void> => {
		if (!rpc || !grantForm || grantBusy) return;
		const name = grantForm.entry.name;
		setGrantBusy(true);
		setGrantError(null);
		try {
			for (const server of grantForm.servers) {
				const recorded = grantForm.grants.find(
					grant => grant.server === server.name && grant.target === server.target,
				);
				const current = recorded ? [...recorded.keys].sort() : [];
				const base = current.filter(key => key !== name);
				const wanted = grantForm.checked.includes(server.name) ? [...base, name].sort() : base;
				if (wanted.length === current.length && wanted.every((key, index) => key === current[index])) continue;
				await rpc.request("secret.setMcpGrant", { server: server.name, target: server.target, keys: wanted });
			}
			setGrantForm(null);
		} catch (error) {
			setGrantError(t("settings.secretsMcpSaveFailed", { error: errorText(error) }));
		} finally {
			setGrantBusy(false);
		}
	};

	/**
	 * The passphrase never leaves this component for anywhere but the daemon's
	 * one request; it is dropped with the form as soon as the call settles.
	 */
	const submitProtection = async (): Promise<void> => {
		if (!rpc || !protection || protectionBusy) return;
		const passphrase = protection.passphrase;
		if (protection.mode === "change") {
			if (passphrase.length < MIN_PASSPHRASE_LENGTH || protection.next.length < MIN_PASSPHRASE_LENGTH) {
				setProtectionError(t("settings.secretsPassphraseTooShort"));
				return;
			}
			if (protection.next !== protection.confirm) {
				setProtectionError(t("settings.secretsPassphraseMismatch"));
				return;
			}
		} else if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
			setProtectionError(t("settings.secretsPassphraseTooShort"));
			return;
		}
		if (protection.mode === "protect" && passphrase !== protection.confirm) {
			setProtectionError(t("settings.secretsPassphraseMismatch"));
			return;
		}
		const method =
			protection.mode === "protect"
				? "secret.encrypt"
				: protection.mode === "remove"
					? "secret.decrypt"
					: protection.mode === "change"
						? "secret.rephrase"
						: "secret.unlock";
		setProtectionBusy(true);
		setProtectionError(null);
		try {
			const nextStatus = await rpc.request<SecretStatusResult>(
				method,
				protection.mode === "change" ? { current: passphrase, next: protection.next } : { passphrase },
			);
			setStatus(nextStatus ?? null);
			// Drop the typed passphrase on success; keep the form on failure so the
			// user can correct a typo instead of retyping from scratch.
			setProtection(null);
		} catch (error) {
			setProtectionError(
				t(protection.mode === "unlock" ? "settings.secretsUnlockFailed" : "settings.secretsProtectionFailed", {
					error: errorText(error),
				}),
			);
		} finally {
			setProtectionBusy(false);
		}
	};

	const openAdd = (): void => {
		tapFeedback();
		setFormError(null);
		setActionError(null);
		setForm({ mode: "add", name: "", purpose: "", value: "", delivery: "env" });
	};

	const openReplace = (entry: SecretEntryView): void => {
		tapFeedback();
		setFormError(null);
		setActionError(null);
		setForm({
			mode: "replace",
			name: entry.name,
			purpose: entry.purpose,
			value: "",
			delivery: entry.delivery,
		});
	};

	const closeForm = (): void => {
		// Drop the value with the form; nothing keeps it in component state.
		setForm(null);
		setFormError(null);
	};

	const closeImport = (): void => {
		setImporting(false);
		setEnvText("");
		setEnvError(null);
		setEnvDone(null);
	};

	/** One `NAME=value` per line; blanks and `#` comments are ignored. */
	const importEnv = async (): Promise<void> => {
		if (!rpc || busy) return;
		const lines = envText.split(/\r?\n/u);
		const entries: Array<{ name: string; value: string }> = [];
		for (const [index, raw] of lines.entries()) {
			const line = raw.trim();
			if (line === "" || line.startsWith("#")) continue;
			const eq = line.indexOf("=");
			const name = eq === -1 ? "" : line.slice(0, eq).trim();
			const value = eq === -1 ? "" : line.slice(eq + 1).trim();
			if (!SECRET_NAME_PATTERN.test(name)) {
				setEnvError(t("settings.secretsImportInvalid", { line: index + 1, name }));
				return;
			}
			if (value.length < MIN_SECRET_VALUE_LENGTH) {
				setEnvError(t("settings.secretsSetFailed", { error: t("settings.secretsValueTooShort") }));
				return;
			}
			entries.push({ name, value });
		}
		if (entries.length === 0) {
			setEnvError(t("settings.secretsImportEmpty"));
			return;
		}
		setBusy(true);
		setEnvError(null);
		setEnvDone(null);
		let saved = 0;
		try {
			for (const entry of entries) {
				await rpc.request("secret.set", { name: entry.name, value: entry.value });
				saved++;
			}
			setEnvDone(entries.length);
			setEnvText("");
			reload();
		} catch (error) {
			setEnvError(t("settings.secretsImportFailed", { done: saved, error: errorText(error) }));
			if (saved > 0) reload();
		} finally {
			setBusy(false);
		}
	};

	const submitForm = async (): Promise<void> => {
		if (!rpc || !form || busy) return;
		const name = form.name.trim();
		const value = form.value;
		if (form.mode === "add" && !SECRET_NAME_PATTERN.test(name)) {
			setFormError(t("settings.secretsInvalidName"));
			return;
		}
		if (!value) {
			setFormError(t("settings.secretsValueRequired"));
			return;
		}
		if (value.length < MIN_SECRET_VALUE_LENGTH) {
			setFormError(t("settings.secretsValueTooShort"));
			return;
		}
		if (form.mode === "add" && entries.some(entry => entry.name === name)) {
			setFormError(t("settings.secretsNameExists"));
			return;
		}
		setBusy(true);
		setFormError(null);
		try {
			const result = await rpc.request<{ entry?: SecretEntryView }>("secret.set", {
				name,
				value,
				// Replace keeps the stored purpose; add records it when present.
				...(form.mode === "add" && form.purpose.trim() ? { purpose: form.purpose.trim() } : {}),
			});
			if (result?.entry) {
				const entry = result.entry;
				setEntries(current =>
					current.some(item => item.name === entry.name)
						? current.map(item => (item.name === entry.name ? entry : item))
						: [...current, entry],
				);
			} else {
				reload();
			}
			setForm(null);
		} catch (error) {
			// The daemon's own reason stays in the form: it names what was
			// refused, which a generic "could not save" would drop.
			setFormError(t("settings.secretsSetFailed", { error: errorText(error) }));
		} finally {
			setBusy(false);
		}
	};

	const widen = async (entry: SecretEntryView): Promise<void> => {
		if (!rpc || widening) return;
		setWidening(entry.name);
		setActionError(null);
		try {
			const result = await rpc.request<{ entry?: SecretEntryView }>("secret.update", {
				name: entry.name,
				scope: "all",
			});
			if (result?.entry) {
				const updated = result.entry;
				setEntries(current => current.map(item => (item.name === updated.name ? updated : item)));
			} else {
				reload();
			}
		} catch (error) {
			setActionError(t("settings.secretsUpdateFailed", { error: errorText(error) }));
		} finally {
			setWidening(null);
		}
	};

	const remove = async (entry: SecretEntryView): Promise<void> => {
		if (!rpc || deleting) return;
		const accepted = await confirm(
			t("settings.secretsDeleteConfirm", { name: entry.name }),
			t("settings.secretsDelete"),
			{ destructive: true },
		);
		if (!accepted) return;
		setDeleting(entry.name);
		setActionError(null);
		try {
			await rpc.request("secret.delete", { name: entry.name });
			setEntries(current => current.filter(item => item.name !== entry.name));
		} catch (error) {
			setActionError(t("settings.secretsDeleteFailed", { error: errorText(error) }));
		} finally {
			setDeleting(null);
		}
	};

	// The count and empty state are facts about the list, not about the
	// daemon: without a readable list ("0 entries" included) they would
	// contradict the offline/read-failure warning above them.
	const listKnown = rpc !== null && !loading && !listError;
	const normalizedQuery = query.trim().toLowerCase();
	const visible = normalizedQuery
		? entries.filter(entry => `${entry.name} ${entry.purpose}`.toLowerCase().includes(normalizedQuery))
		: entries;
	const bodyOpen = form !== null || importing || grantForm !== null;
	const locked = status?.locked === true;
	const passphraseProtected = status?.protectedBy === "passphrase";
	const protectionAction = locked
		? t("settings.secretsUnlock")
		: passphraseProtected
			? t("settings.secretsRemovePassphrase")
			: t("settings.secretsProtectWithPassphrase");

	return (
		<div className="gui-settings-section gui-secret-section">
			<h2 className="gui-settings-page-title">{t("settings.secrets")}</h2>
			<p className="gui-settings-page-desc">{t("settings.secretsDescription")}</p>

			{!rpc && <WarningLine message={t("settings.secretsOffline")} />}
			{statusError && (
				<WarningLine message={t("settings.secretsStatusFailed", { error: statusError })} onRetry={reload} />
			)}
			{listError && <WarningLine message={t("settings.secretsListFailed", { error: listError })} onRetry={reload} />}
			{actionError && <WarningLine message={actionError} />}

			{/* How the master key is stored, and the one action that changes it. A
			 * locked store keeps this row as the only way back in, so it is not
			 * hidden behind the list. */}
			{status && (
				<div
					className={`gui-agent-card gui-secret-protection${locked ? " gui-secret-protection--locked" : ""}`}
					data-secret-protection={status.protectedBy ?? "key-file"}
					data-secret-locked={locked ? "true" : "false"}
				>
					<div className="gui-secret-protection-main">
						<span className="gui-secret-row-icon">
							{locked || status.protectedBy === "passphrase" ? (
								<Lock size={13} aria-hidden="true" />
							) : (
								<KeyRound size={13} aria-hidden="true" />
							)}
						</span>
						<div className="gui-secret-protection-text">
							<span className="gui-secret-protection-title">
								{locked ? t("settings.secretsLockedTitle") : t("settings.secretsProtection")}
							</span>
							<span className="gui-secret-protection-meta">
								{locked
									? lockedReasonText(status.reason)
									: status.protectedBy === "passphrase"
										? t("settings.secretsProtectionPassphrase")
										: t("settings.secretsProtectionKeyFile")}
							</span>
							{/* The same passphrase wraps the connector tokens, so the row
							 * names both rather than letting the user believe one store is
							 * protected while the other is not. */}
							{status.connectors && (
								<span
									className="gui-secret-protection-meta"
									data-secret-connectors={status.connectors.protectedBy}
								>
									{status.connectors.protectedBy === "passphrase"
										? t("settings.secretsProtectionConnectors")
										: t("settings.secretsProtectionConnectorsPlain")}
								</span>
							)}
						</div>
						{!protection && (
							<div className="gui-secret-protection-actions">
								{passphraseProtected && !locked && (
									<button
										type="button"
										className="gui-btn gui-btn-ghost"
										data-secret-action="rephrase"
										onClick={() => openProtection("change")}
									>
										{t("settings.secretsChangePassphrase")}
									</button>
								)}
								<button
									type="button"
									className="gui-btn"
									data-secret-action="protection"
									onClick={() =>
										openProtection(locked ? "unlock" : passphraseProtected ? "remove" : "protect")
									}
								>
									{protectionAction}
								</button>
							</div>
						)}
					</div>
					{protection && (
						<form
							className="gui-secret-protection-form"
							data-secret-protection-form={protection.mode}
							aria-busy={protectionBusy}
							onSubmit={event => {
								event.preventDefault();
								void submitProtection();
							}}
							onKeyDown={event => {
								if (event.key !== "Escape" || protectionBusy) return;
								event.preventDefault();
								event.stopPropagation();
								closeProtection();
							}}
						>
							<label className="gui-settings-field">
								<span className="gui-settings-field-label">
									{protection.mode === "change"
										? t("settings.secretsPassphraseCurrent")
										: t("settings.secretsPassphrase")}
								</span>
								{protection.mode !== "unlock" && (
									<span className="gui-settings-field-hint">
										{protection.mode === "protect"
											? t("settings.secretsPassphraseHint")
											: protection.mode === "change"
												? t("settings.secretsPassphraseChangeHint")
												: t("settings.secretsPassphraseRemoveHint")}
									</span>
								)}
								<span className="gui-settings-field-control">
									<input
										type="password"
										className="gui-secret-input"
										data-secret-field="passphrase"
										value={protection.passphrase}
										autoComplete={
											protection.mode === "unlock" || protection.mode === "change"
												? "current-password"
												: "new-password"
										}
										autoFocus
										disabled={protectionBusy}
										onChange={event => {
											setProtectionError(null);
											setProtection(current =>
												current ? { ...current, passphrase: event.target.value } : current,
											);
										}}
									/>
								</span>
							</label>
							{protection.mode === "change" && (
								<label className="gui-settings-field">
									<span className="gui-settings-field-label">{t("settings.secretsPassphraseNext")}</span>
									<span className="gui-settings-field-control">
										<input
											type="password"
											className="gui-secret-input"
											data-secret-field="next"
											value={protection.next}
											autoComplete="new-password"
											disabled={protectionBusy}
											onChange={event => {
												setProtectionError(null);
												setProtection(current =>
													current ? { ...current, next: event.target.value } : current,
												);
											}}
										/>
									</span>
								</label>
							)}
							{(protection.mode === "protect" || protection.mode === "change") && (
								<label className="gui-settings-field">
									<span className="gui-settings-field-label">
										{protection.mode === "change"
											? t("settings.secretsPassphraseNextConfirm")
											: t("settings.secretsPassphraseConfirm")}
									</span>
									<span className="gui-settings-field-control">
										<input
											type="password"
											className="gui-secret-input"
											data-secret-field="confirm"
											value={protection.confirm}
											autoComplete="new-password"
											disabled={protectionBusy}
											onChange={event => {
												setProtectionError(null);
												setProtection(current =>
													current ? { ...current, confirm: event.target.value } : current,
												);
											}}
										/>
									</span>
								</label>
							)}
							<div className="gui-secret-form-foot">
								<span className="gui-settings-field-hint">{t("settings.secretsPassphraseNote")}</span>
								<div className="gui-secret-form-actions">
									<button
										type="button"
										className="gui-btn"
										onClick={closeProtection}
										disabled={protectionBusy}
									>
										{t("settings.cancel")}
									</button>
									<button type="submit" className="gui-btn gui-btn-primary" disabled={protectionBusy}>
										{protectionBusy
											? t("settings.secretsSaving")
											: protection.mode === "change"
												? t("settings.secretsChangePassphrase")
												: protectionAction}
									</button>
								</div>
							</div>
							{protectionError && (
								<div className="gui-secret-form-error" role="alert">
									{protectionError}
								</div>
							)}
						</form>
					)}
				</div>
			)}

			{listKnown && (
				<div className="gui-secret-listhead">
					<span className="gui-secret-count">{t("settings.secretsStoredCount", { count: entries.length })}</span>
					{entries.length > 0 && (
						<input
							className="gui-input gui-secret-search"
							value={query}
							placeholder={t("settings.secretsSearch")}
							aria-label={t("settings.secretsSearch")}
							spellCheck={false}
							onChange={event => setQuery(event.target.value)}
						/>
					)}
					<div className="gui-secret-listhead-actions">
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={bodyOpen || locked}
							onClick={openAdd}
						>
							<Plus size={13} aria-hidden="true" /> {t("settings.secretsAdd")}
						</button>
						<button
							type="button"
							className="gui-btn"
							disabled={bodyOpen || locked}
							onClick={() => {
								setForm(null);
								setFormError(null);
								setImporting(true);
								setEnvError(null);
								setEnvDone(null);
							}}
						>
							{t("settings.secretsImport")}
						</button>
					</div>
				</div>
			)}

			{/* One body, never two: an open form replaces the rows/empty state
			 * instead of stacking above them. `保险库 · N` stays visible because
			 * it is a fact about the list. */}
			{loading ? (
				<div className="gui-secret-loading">{t("settings.loading")}</div>
			) : form ? (
				<SecretForm
					form={form}
					busy={busy}
					error={formError}
					onChange={patch => {
						setFormError(null);
						setForm(current => (current ? { ...current, ...patch } : current));
					}}
					onCancel={closeForm}
					onSubmit={() => void submitForm()}
				/>
			) : importing ? (
				<form
					className="gui-agent-card gui-secret-form"
					aria-busy={busy}
					onSubmit={event => {
						event.preventDefault();
						void importEnv();
					}}
					onKeyDown={event => {
						if (event.key !== "Escape" || busy) return;
						event.preventDefault();
						event.stopPropagation();
						closeImport();
					}}
				>
					<div className="gui-secret-form-head">
						<span className="gui-secret-form-title">{t("settings.secretsImportTitle")}</span>
					</div>
					<label className="gui-settings-field">
						<span className="gui-settings-field-label">{t("settings.secretsImportLabel")}</span>
						<span className="gui-settings-field-hint">{t("settings.secretsImportHint")}</span>
						<span className="gui-settings-field-control">
							<textarea
								className="gui-secret-input gui-secret-input--mono"
								data-secret-field="env"
								rows={5}
								value={envText}
								spellCheck={false}
								autoComplete="off"
								dir="ltr"
								placeholder={t("settings.secretsImportPlaceholder")}
								autoFocus
								disabled={busy}
								onChange={event => {
									setEnvError(null);
									setEnvDone(null);
									setEnvText(event.target.value);
								}}
							/>
						</span>
					</label>
					{envDone !== null && (
						<p role="status" className="gui-note">
							{t("settings.secretsImportDone", { count: envDone })}
						</p>
					)}
					{envError && (
						<div className="gui-secret-form-error" role="alert">
							{envError}
						</div>
					)}
					<div className="gui-secret-form-foot">
						<span className="gui-settings-field-hint">{t("settings.secretsImportScope")}</span>
						<div className="gui-secret-form-actions">
							<button type="button" className="gui-btn" onClick={closeImport} disabled={busy}>
								{t("settings.cancel")}
							</button>
							{envDone !== null ? (
								<button type="button" className="gui-btn gui-btn-primary" onClick={closeImport}>
									{t("settings.secretsImportFinish")}
								</button>
							) : (
								<button type="submit" className="gui-btn gui-btn-primary" disabled={busy}>
									{busy ? t("settings.secretsSaving") : t("settings.secretsImportSubmit")}
								</button>
							)}
						</div>
					</div>
				</form>
			) : grantForm ? (
				<form
					className="gui-agent-card gui-secret-form"
					data-secret-grant-form={grantForm.entry.name}
					aria-busy={grantBusy}
					onSubmit={event => {
						event.preventDefault();
						void saveGrant();
					}}
					onKeyDown={event => {
						if (event.key !== "Escape" || grantBusy) return;
						event.preventDefault();
						event.stopPropagation();
						setGrantForm(null);
					}}
				>
					<div className="gui-secret-form-head">
						<span className="gui-secret-form-title">
							{t("settings.secretsMcpTitle", { name: grantForm.entry.name })}
						</span>
					</div>
					{grantForm.servers.length === 0 ? (
						<p className="gui-note">{t("settings.secretsMcpNoServers")}</p>
					) : (
						<ul className="gui-secret-grant-list">
							{grantForm.servers.map(server => (
								<li key={server.name}>
									<label className="gui-secret-grant-row" data-mcp-server={server.name}>
										<input
											type="checkbox"
											checked={grantForm.checked.includes(server.name)}
											disabled={grantBusy}
											onChange={event => toggleGrant(server.name, event.target.checked)}
										/>
										<span className="gui-secret-grant-name">{server.name}</span>
										<span className="gui-secret-grant-target" title={server.target}>
											{server.target}
										</span>
									</label>
								</li>
							))}
						</ul>
					)}
					<div className="gui-secret-form-foot">
						<span className="gui-settings-field-hint">{t("settings.secretsMcpHint")}</span>
						<div className="gui-secret-form-actions">
							<button type="button" className="gui-btn" onClick={() => setGrantForm(null)} disabled={grantBusy}>
								{t("settings.cancel")}
							</button>
							<button
								type="submit"
								className="gui-btn gui-btn-primary"
								disabled={grantBusy || grantForm.servers.length === 0}
							>
								{grantBusy ? t("settings.secretsSaving") : t("general.save")}
							</button>
						</div>
					</div>
					{grantError && (
						<div className="gui-secret-form-error" role="alert">
							{grantError}
						</div>
					)}
				</form>
			) : !listKnown ? null : entries.length === 0 ? (
				<div className="gui-secret-empty">
					<div className="gui-secret-empty-title">{t("settings.secretsEmptyTitle")}</div>
					<p className="gui-secret-empty-body">{t("settings.secretsEmptyBody")}</p>
				</div>
			) : visible.length === 0 ? (
				<div className="gui-secret-none">{t("settings.secretsNoMatch")}</div>
			) : (
				<ul className="gui-secret-list">
					{visible.map(entry => {
						const meta = [
							entry.delivery === "file" ? t("settings.secretsDeliveryFile") : null,
							entry.scope === "all" ? null : scopeLabel(entry.scope),
							entry.purpose || null,
							entry.lastUsedAt ? lastUsedText(entry) : null,
						]
							.filter(Boolean)
							.join(" · ");
						return (
							<li key={entry.name} className="gui-agent-card gui-secret-row" data-secret-name={entry.name}>
								<span className="gui-secret-row-icon">
									<KeyRound size={13} aria-hidden="true" />
								</span>
								<div className="gui-secret-row-main">
									<div className="gui-secret-row-head">
										<span className="gui-secret-name">{entry.name}</span>
									</div>
									{meta !== "" && <div className="gui-secret-row-meta-line">{meta}</div>}
								</div>
								<div className="gui-secret-row-actions">
									{entry.scope !== "all" && (
										<button
											type="button"
											className="gui-btn gui-btn-ghost"
											data-secret-action="widen"
											disabled={widening === entry.name || locked}
											onClick={() => void widen(entry)}
										>
											{t("settings.secretsAllowAll")}
										</button>
									)}
									<button
										type="button"
										className="gui-btn gui-btn-ghost"
										data-secret-action="mcp"
										disabled={locked || grantBusy}
										onClick={() => void openGrant(entry)}
									>
										{t("settings.secretsMcpAccess")}
									</button>
									<button
										type="button"
										className="gui-btn gui-btn-ghost"
										data-secret-action="replace"
										disabled={locked}
										onClick={() => openReplace(entry)}
									>
										{t("settings.secretsReplace")}
									</button>
									<button
										type="button"
										className="gui-btn gui-btn-ghost gui-btn-icon"
										data-secret-action="delete"
										aria-label={`${t("settings.secretsDelete")} ${entry.name}`}
										disabled={deleting === entry.name || locked}
										onClick={() => void remove(entry)}
									>
										<Trash2 size={13} aria-hidden="true" />
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			<p className="gui-note gui-secret-footnote">{t("settings.secretsFootnote")}</p>
		</div>
	);
}
