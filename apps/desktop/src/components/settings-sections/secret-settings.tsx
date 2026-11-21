/**
 * Settings → 智能体 → 密钥: the agent secret vault.
 *
 * Values are write-only over this page: the daemon returns metadata only
 * (`secret.list`), and every input that accepts a value is a password field.
 * The page never renders a stored value, offers a reveal toggle, or keeps a
 * value after its form closes.
 *
 * The store is always encrypted with a local per-profile master key, so the
 * status row is static — there is no plaintext mode and no unlock step.
 */

import { t } from "@musepi/client-core";
import { formatWhen } from "@musepi/client-core/src/lib/format";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
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

interface SecretFormState {
	mode: "add" | "replace";
	name: string;
	purpose: string;
	value: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function statusLine(entry: SecretEntryView): string {
	return entry.lastUsedAt && entry.lastUsedAt > 0
		? t("settings.secretsLastUsed", { when: formatWhen(entry.lastUsedAt) })
		: t("settings.secretsNeverUsed");
}

function WarningLine({ message, onRetry }: { message: string; onRetry?: () => void }): ReactNode {
	return (
		<div className="gui-settings-row-desc--warn flex items-center gap-2 text-[12px]">
			<span className="min-w-0 flex-1">{message}</span>
			{onRetry && (
				<button type="button" className="gui-btn-ghost shrink-0" onClick={onRetry}>
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
			className="gui-agent-card flex-col items-stretch gap-2"
			onSubmit={event => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="gui-settings-row-label">
					{form.mode === "add" ? t("settings.secretsAddTitle") : t("settings.secretsReplaceTitle")}
				</div>
				<button type="button" className="gui-btn-ghost" onClick={onCancel} disabled={busy}>
					{t("settings.cancel")}
				</button>
			</div>
			{form.mode === "add" ? (
				<label className="block">
					<span className="text-[11.5px] text-[var(--color-text-muted)]">{t("settings.secretsName")}</span>
					<input
						className="gui-input mt-1 w-full font-mono"
						data-secret-field="name"
						value={form.name}
						placeholder={t("settings.secretsNamePlaceholder")}
						spellCheck={false}
						autoComplete="off"
						disabled={busy}
						onChange={event => onChange({ name: event.target.value })}
					/>
					<span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
						{t("settings.secretsNameHint")}
					</span>
				</label>
			) : (
				<div className="font-mono text-[13px]">{form.name}</div>
			)}
			<label className="block">
				<span className="text-[11.5px] text-[var(--color-text-muted)]">{t("settings.secretsValue")}</span>
				<input
					// Masked control; no reveal affordance on this page.
					type="password"
					className="gui-input mt-1 w-full"
					data-secret-field="value"
					value={form.value}
					placeholder={t("settings.secretsValuePlaceholder")}
					spellCheck={false}
					autoComplete="new-password"
					disabled={busy}
					onChange={event => onChange({ value: event.target.value })}
				/>
				<span className="mt-1 block text-[11px] text-[var(--color-text-muted)]">
					{t("settings.secretsValueHint")}
				</span>
			</label>
			{form.mode === "add" && (
				<label className="block">
					<span className="text-[11.5px] text-[var(--color-text-muted)]">{t("settings.secretsPurpose")}</span>
					<input
						className="gui-input mt-1 w-full"
						data-secret-field="purpose"
						value={form.purpose}
						placeholder={t("settings.secretsPurposePlaceholder")}
						disabled={busy}
						onChange={event => onChange({ purpose: event.target.value })}
					/>
				</label>
			)}
			<div className="flex items-center gap-2">
				<span className="text-[11px] text-[var(--color-text-muted)]">
					{t("settings.secretsScope")}: {t("settings.secretsScopeAll")}
				</span>
				<span className="flex-1" />
				<button type="submit" className="gui-btn gui-btn-primary" disabled={busy}>
					{busy ? t("settings.secretsSaving") : t("general.save")}
				</button>
			</div>
			{error && <div className="text-[12px] text-[var(--color-warning)]">{error}</div>}
		</form>
	);
}

export function SecretSettingsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const { confirm } = useConfirm();
	const [status, setStatus] = useState<SecretStatusResult | null>(null);
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
			setStatus(null);
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
			if (statusResult.status === "fulfilled") {
				setStatus(statusResult.value);
			} else {
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
		if (value.length < 8) {
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

	// The visible list is authoritative once it loads; the status count covers
	// the one case it cannot (the list request failed).
	const count = listError ? (status?.count ?? entries.length) : entries.length;

	return (
		<div className="gui-settings-section">
			<h2 className="gui-settings-page-title">{t("settings.secrets")}</h2>
			<div className="gui-agent-card">
				<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-elevated)]">
					<KeyRound size={15} aria-hidden="true" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="gui-settings-row-label">{t("settings.secretsEncrypted")}</div>
					<div className="gui-settings-row-desc">{t("settings.secretsEncryptedDescription")}</div>
				</div>
			</div>
			{!rpc && <WarningLine message={t("settings.secretsOffline")} />}
			{statusError && (
				<WarningLine message={t("settings.secretsStatusFailed", { error: statusError })} onRetry={reload} />
			)}
			{listError && <WarningLine message={t("settings.secretsListFailed", { error: listError })} onRetry={reload} />}
			{actionError && <WarningLine message={actionError} />}
			<div className="mt-3 flex items-center justify-between gap-2">
				<div className="text-[12px] text-[var(--color-text-muted)]">
					{t("settings.secretsStoredCount", { count })}
				</div>
				<button
					type="button"
					className="gui-btn gui-btn-primary shrink-0"
					disabled={!rpc || form !== null || loading || listError !== null}
					onClick={openAdd}
				>
					<Plus size={13} aria-hidden="true" /> {t("settings.secretsAdd")}
				</button>
			</div>
			{form && (
				<SecretForm
					form={form}
					busy={busy}
					error={formError}
					onChange={patch => setForm(current => (current ? { ...current, ...patch } : current))}
					onCancel={closeForm}
					onSubmit={() => void submitForm()}
				/>
			)}
			{loading ? (
				<div className="gui-settings-row">{t("settings.loading")}</div>
			) : listError ? null : entries.length === 0 ? (
				<div className="gui-agent-card text-[12.5px] text-[var(--color-text-muted)]">
					{t("settings.secretsEmpty")}
				</div>
			) : (
				entries.map(entry => (
					<div key={entry.name} className="gui-agent-card" data-secret-name={entry.name}>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<div className="flex items-center gap-1.5">
								<span className="truncate font-mono text-[13px] font-medium">{entry.name}</span>
								<span className="gui-provider-chip">{t("settings.secretsScopeAll")}</span>
							</div>
							<div className="truncate text-[12px] text-[var(--color-text-muted)]">
								{entry.purpose || t("settings.secretsNoPurpose")}
							</div>
							<div className="text-[11px] text-[var(--color-text-muted)]">{statusLine(entry)}</div>
						</div>
						<button
							type="button"
							className="gui-btn-ghost shrink-0"
							data-secret-action="replace"
							onClick={() => openReplace(entry)}
						>
							{t("settings.secretsReplace")}
						</button>
						<button
							type="button"
							className="gui-btn-ghost shrink-0"
							data-secret-action="delete"
							aria-label={`${t("settings.secretsDelete")} ${entry.name}`}
							disabled={deleting === entry.name}
							onClick={() => void remove(entry)}
						>
							<Trash2 size={13} aria-hidden="true" />
						</button>
					</div>
				))
			)}
		</div>
	);
}
