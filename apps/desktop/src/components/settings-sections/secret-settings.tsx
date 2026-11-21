/**
 * Settings → 智能体 → 密钥: the agent secret vault.
 *
 * Values are write-only over this page: the daemon returns metadata only
 * (`secret.list`), and every input that accepts a value is a masked field.
 * The page never renders a stored value, offers a reveal toggle, or keeps a
 * value after its form closes.
 *
 * The store is always encrypted with a local per-profile master key, so the
 * state card is static — there is no plaintext mode, no unlock step, and
 * nothing for the page to switch on. Its copy stays on what the code does:
 * `packages/coding-agent/src/secrets/agent-store.ts` writes one AES-256-GCM
 * envelope per name and a metadata sidecar at 0600; a value reaches a bash
 * child as `$MUSEPI_SECRET_<NAME>`, tool output shows `[secret:NAME]`, and the
 * provider boundary carries a keyed placeholder instead of the value.
 */

import { t } from "@musepi/client-core";
import { formatWhen } from "@musepi/client-core/src/lib/format";
import { Eye, FolderLock, KeyRound, Plus, RefreshCw, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import { useConfirm } from "../../lib/prompt-dialog";
import type { RpcClient } from "../../lib/rpc";

/** Wire contract for the daemon's `secret.*` methods. Timestamps are epoch ms. */
type SecretScope = "all";

interface SecretEntryView {
	name: string;
	purpose: string;
	scope: SecretScope;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
}

interface SecretStatusResult {
	mode: "encrypted";
	count: number;
}

interface SecretListResult {
	entries: SecretEntryView[];
	count: number;
}

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MIN_SECRET_VALUE_LENGTH = 8;

interface SecretFormState {
	mode: "add" | "replace";
	name: string;
	purpose: string;
	value: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lastUsedText(entry: SecretEntryView): string {
	return entry.lastUsedAt && entry.lastUsedAt > 0
		? t("settings.secretsLastUsed", { when: formatWhen(entry.lastUsedAt) })
		: t("settings.secretsNeverUsed");
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

/** One fact of the state card: what is protected, and by which mechanism. */
function SecretFact({ icon, title, value }: { icon: ReactNode; title: string; value: string }): ReactNode {
	return (
		<div className="gui-secret-fact">
			<span className="gui-secret-fact-icon">{icon}</span>
			<div className="gui-secret-fact-body">
				<div className="gui-secret-fact-title">{title}</div>
				<div className="gui-secret-fact-value">{value}</div>
			</div>
		</div>
	);
}

/**
 * The page's single claim about storage. Static on purpose: the daemon reports
 * `mode: "encrypted"` from the same store implementation, and there is no
 * second mode for a status read to discover — only whether it could be read,
 * which the warnings beside this card report.
 */
function SecretStateCard(): ReactNode {
	return (
		<section className="gui-agent-card gui-secret-state" aria-label={t("settings.secretsEncrypted")}>
			<div className="gui-secret-state-head">
				<span className="gui-secret-state-icon">
					<ShieldCheck size={16} aria-hidden="true" />
				</span>
				<div className="gui-secret-state-text">
					<div className="gui-secret-state-title">{t("settings.secretsEncrypted")}</div>
					<div className="gui-secret-state-desc">{t("settings.secretsEncryptedDescription")}</div>
				</div>
			</div>
			<div className="gui-secret-facts">
				<SecretFact
					icon={<FolderLock size={13} aria-hidden="true" />}
					title={t("settings.secretsWhereTitle")}
					value={t("settings.secretsWhereValue")}
				/>
				<SecretFact
					icon={<Terminal size={13} aria-hidden="true" />}
					title={t("settings.secretsBashTitle")}
					value={t("settings.secretsBashValue")}
				/>
				<SecretFact
					icon={<Eye size={13} aria-hidden="true" />}
					title={t("settings.secretsModelTitle")}
					value={t("settings.secretsModelValue")}
				/>
			</div>
		</section>
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
			onSubmit={event => {
				event.preventDefault();
				onSubmit();
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
							disabled={busy}
							onChange={event => onChange({ name: event.target.value })}
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
	const [loading, setLoading] = useState(false);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [form, setForm] = useState<SecretFormState | null>(null);
	const [formError, setFormError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	const reload = useCallback((): void => {
		setReloadToken(token => token + 1);
	}, []);

	useEffect(() => {
		if (!rpc) {
			setEntries([]);
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
			if (statusResult.status === "rejected") {
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

	const openAdd = (): void => {
		tapFeedback();
		setFormError(null);
		setActionError(null);
		setForm({ mode: "add", name: "", purpose: "", value: "" });
	};

	const openReplace = (entry: SecretEntryView): void => {
		tapFeedback();
		setFormError(null);
		setActionError(null);
		setForm({ mode: "replace", name: entry.name, purpose: entry.purpose, value: "" });
	};

	const closeForm = (): void => {
		// Drop the value with the form; nothing keeps it in component state.
		setForm(null);
		setFormError(null);
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
			if (form?.mode === "replace" && form.name === entry.name) closeForm();
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

	return (
		<div className="gui-settings-section gui-secret-section">
			<h2 className="gui-settings-page-title">{t("settings.secrets")}</h2>
			<p className="gui-settings-page-desc">{t("settings.secretsDescription")}</p>

			<SecretStateCard />

			{!rpc && <WarningLine message={t("settings.secretsOffline")} />}
			{statusError && (
				<WarningLine message={t("settings.secretsStatusFailed", { error: statusError })} onRetry={reload} />
			)}
			{listError && <WarningLine message={t("settings.secretsListFailed", { error: listError })} onRetry={reload} />}
			{actionError && <WarningLine message={actionError} />}

			{listKnown && (
				<div className="gui-secret-listhead">
					<span className="gui-secret-count">{t("settings.secretsStoredCount", { count: entries.length })}</span>
					<button type="button" className="gui-btn gui-btn-primary" disabled={form !== null} onClick={openAdd}>
						<Plus size={13} aria-hidden="true" /> {t("settings.secretsAdd")}
					</button>
				</div>
			)}

			{/* One body, never two: the open form replaces the rows/empty state
			 * instead of stacking above them. `密钥 · N` stays visible because it
			 * is a fact about the list, and the add action is disabled while a
			 * form is open (a second form is not a state this page has). */}
			{loading ? (
				<div className="gui-secret-loading">{t("settings.loading")}</div>
			) : form ? (
				<SecretForm
					form={form}
					busy={busy}
					error={formError}
					onChange={patch => setForm(current => (current ? { ...current, ...patch } : current))}
					onCancel={closeForm}
					onSubmit={() => void submitForm()}
				/>
			) : !listKnown ? null : entries.length === 0 ? (
				<div className="gui-secret-empty">
					<div className="gui-secret-empty-title">{t("settings.secretsEmptyTitle")}</div>
					<p className="gui-secret-empty-body">{t("settings.secretsEmptyBody")}</p>
				</div>
			) : (
				<div className="gui-secret-list">
					{entries.map(entry => (
						<section key={entry.name} className="gui-agent-card gui-secret-row" data-secret-name={entry.name}>
							<span className="gui-secret-row-icon">
								<KeyRound size={13} aria-hidden="true" />
							</span>
							<div className="gui-secret-row-main">
								<div className="gui-secret-row-head">
									<span className="gui-secret-name">{entry.name}</span>
									<span className="gui-provider-chip">{t("settings.secretsScopeAll")}</span>
								</div>
								<div className="gui-secret-row-purpose">{entry.purpose || t("settings.secretsNoPurpose")}</div>
							</div>
							<span className="gui-secret-row-meta">{lastUsedText(entry)}</span>
							<div className="gui-secret-row-actions">
								<button
									type="button"
									className="gui-btn gui-btn-ghost"
									data-secret-action="replace"
									onClick={() => openReplace(entry)}
								>
									{t("settings.secretsReplace")}
								</button>
								<button
									type="button"
									className="gui-btn gui-btn-ghost gui-btn-icon"
									data-secret-action="delete"
									aria-label={`${t("settings.secretsDelete")} ${entry.name}`}
									disabled={deleting === entry.name}
									onClick={() => void remove(entry)}
								>
									<Trash2 size={13} aria-hidden="true" />
								</button>
							</div>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
