import { fmtCost, fmtTokens, type TranslationKey, t } from "@musepi/client-core";
import type { SessionDirectoryInfo } from "@musepi/pi-wire";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { SlotComponentProps } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";

/** Wire shape of the existing `session.contextUsage` response. */
interface ContextUsageView {
	tokens: number;
	contextWindow: number;
	percent: number;
	model?: string | null;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: number;
		cacheHitRate: number | null;
	} | null;
}

/** The `session.list` row fields this panel reads. */
interface SessionListRow {
	id: string;
	cwd?: string;
	model?: string;
	messageCount?: number;
}

type ApprovalMode = "always-ask" | "write" | "yolo";

const APPROVAL_LABELS: Record<ApprovalMode, TranslationKey> = {
	"always-ask": "general.approvalModeAlwaysAsk",
	write: "general.approvalModeWrite",
	yolo: "general.approvalModeYolo",
};

const POLL_MS = 10_000;

function isApprovalMode(value: unknown): value is ApprovalMode {
	return value === "always-ask" || value === "write" || value === "yolo";
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Percent for the window bar; clamped so a stale over-100 reading still paints. */
function barWidth(percent: number): string {
	return `${Math.min(100, Math.max(0, percent))}%`;
}

export default function SessionInfoPage({ rpc, sessionId, cwd }: SlotComponentProps): ReactNode {
	const [row, setRow] = useState<SessionListRow | null>(null);
	const [usage, setUsage] = useState<ContextUsageView | null>(null);
	const [usageUnavailable, setUsageUnavailable] = useState(false);
	const [directories, setDirectories] = useState<SessionDirectoryInfo[] | null>(null);
	const [approval, setApproval] = useState<ApprovalMode | null>(null);
	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [reloadToken, setReloadToken] = useState(0);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestSeq = useRef(0);

	useEffect(() => {
		return () => {
			if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
		};
	}, []);

	useEffect(() => {
		setRow(null);
		setUsage(null);
		setUsageUnavailable(false);
		setDirectories(null);
		setApproval(null);
		setError(null);
		setCopied(false);
		if (!rpc || !sessionId) {
			setStatus("idle");
			return;
		}
		const seq = ++requestSeq.current;
		setStatus("loading");
		let alive = true;
		const load = async (): Promise<void> => {
			const [list, context, settings, directoryList] = await Promise.allSettled([
				rpc.request<SessionListRow[]>("session.list"),
				rpc.request<ContextUsageView | null>("session.contextUsage", { sessionId }),
				rpc.request<Record<string, unknown>>("settings.get", { keys: ["tools.approvalMode"] }),
				rpc.request<{ directories?: SessionDirectoryInfo[] }>("session.directories.list", { sessionId }),
			]);
			// A session switch invalidates this run even if the RPC resolves.
			if (!alive || seq !== requestSeq.current) return;
			if (list.status === "fulfilled") {
				setRow(list.value.find(entry => entry.id === sessionId) ?? null);
			} else {
				setError(errorText(list.reason));
				setStatus("error");
				return;
			}
			if (context.status === "fulfilled") {
				setUsage(context.value);
				setUsageUnavailable(context.value === null);
			} else {
				// A snapshot session is not live in the daemon: the idle context
				// readout stays empty instead of failing the whole panel.
				setUsage(null);
				setUsageUnavailable(true);
			}
			if (settings.status === "fulfilled") {
				const value = settings.value?.["tools.approvalMode"];
				setApproval(isApprovalMode(value) ? value : null);
			}
			// Same live-session rule as the context readout: a snapshot has no
			// directory list, and the section says so instead of inventing one.
			setDirectories(
				directoryList.status === "fulfilled" && Array.isArray(directoryList.value?.directories)
					? directoryList.value.directories
					: null,
			);
			setStatus("ready");
		};
		void load();
		const timer = setInterval(() => void load(), POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, sessionId, reloadToken]);

	const copySessionId = useCallback((): void => {
		if (!sessionId || !navigator.clipboard) return;
		void navigator.clipboard
			.writeText(sessionId)
			.then(() => {
				setCopied(true);
				if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
				copiedTimer.current = setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	}, [sessionId]);

	if (!rpc || !sessionId) {
		return (
			<div className="gui-pane-tab-empty" role="status">
				<span className="gui-pane-tab-empty-icon">
					<Icon name="list-unordered" />
				</span>
				<p className="gui-pane-tab-empty-title">{t("sessionInfo.empty")}</p>
				<p className="gui-pane-tab-empty-hint">{t("sessionInfo.emptyHint")}</p>
			</div>
		);
	}

	if (status === "error") {
		return (
			<div className="flex flex-col gap-2 px-3 py-3" role="alert">
				<div className="gui-group-label">{t("sessionInfo.error")}</div>
				<p className="m-0 text-[12px] text-[var(--color-text-faint)]">{error}</p>
				<button
					type="button"
					className="gui-pane-action w-auto self-start"
					onClick={() => setReloadToken(token => token + 1)}
				>
					<Icon name="restart" className="h-3.5 w-3.5" />
					<span>{t("sessionInfo.retry")}</span>
				</button>
			</div>
		);
	}

	if (status === "loading" && row === null) {
		return (
			<div className="flex items-center gap-2 px-3 py-3 text-[12px] text-[var(--color-text-faint)]" role="status">
				<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
				<span>{t("sessionInfo.loading")}</span>
			</div>
		);
	}

	const model = usage?.model ?? row?.model ?? null;
	const workspace = row?.cwd ?? cwd ?? null;
	const messageCount = row?.messageCount ?? null;
	const tokenUsage = usage?.usage ?? null;
	return (
		<div className="flex flex-col gap-3 px-3 py-3 text-[13px]">
			<div className="gui-group-label">{t("sessionInfo.title")}</div>
			<div className="flex items-center gap-1.5">
				<span className="truncate font-mono text-[12px] text-[var(--color-text-muted)]" title={sessionId}>
					{sessionId}
				</span>
				<button
					type="button"
					className="gui-pane-action w-auto flex-shrink-0 px-1.5"
					title={t("transcript.copySessionId")}
					aria-label={t("transcript.copySessionId")}
					onClick={copySessionId}
				>
					<Icon name="clipboard" className="h-3.5 w-3.5" />
					{copied ? <span>{t("general.codeCopied")}</span> : null}
				</button>
			</div>

			<div className="grid grid-cols-2 gap-1.5">
				<div className="gui-ctx-stat">
					<div className="gui-ctx-stat-v">{messageCount ?? "—"}</div>
					<div className="gui-ctx-stat-l">{t("general.messages")}</div>
				</div>
				<div className="gui-ctx-stat">
					<div className="gui-ctx-stat-v truncate" title={approval ? t(APPROVAL_LABELS[approval]) : undefined}>
						{approval ? t(APPROVAL_LABELS[approval]) : "—"}
					</div>
					<div className="gui-ctx-stat-l">{t("general.approvalMode")}</div>
				</div>
			</div>

			<dl className="m-0 flex flex-col gap-1">
				<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
					<Icon name="folder" className="h-3.5 w-3.5 flex-shrink-0" />
					<dt className="flex-shrink-0">{t("settings.cwd")}</dt>
					<dd className="m-0 min-w-0 truncate" title={workspace ?? undefined}>
						{workspace ?? t("sessionInfo.unavailable")}
					</dd>
				</div>
				<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
					<Icon name="ai-agent" className="h-3.5 w-3.5 flex-shrink-0" />
					<dt className="flex-shrink-0">{t("sessionInfo.model")}</dt>
					<dd className="m-0 min-w-0 truncate" title={model ?? undefined}>
						{model ?? t("sessionInfo.unavailable")}
					</dd>
				</div>
			</dl>

			{/* Additional working directories of this session (read-only): the
			 *  daemon owns the list; the files pane is where it is used. */}
			<div>
				<div className="gui-group-label pb-1">
					{directories
						? t("sessionInfo.additionalDirectories", {
								count: directories.filter(entry => !entry.primary).length,
							})
						: t("sessionInfo.workingDirectories")}
				</div>
				{directories === null ? (
					<p className="m-0 text-[12px] text-[var(--color-text-faint)]">{t("sessionInfo.unavailable")}</p>
				) : directories.filter(entry => !entry.primary).length === 0 ? (
					<p className="m-0 text-[12px] text-[var(--color-text-faint)]">
						{t("sessionInfo.noAdditionalDirectories")}
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col gap-1 p-0">
						{directories
							.filter(entry => !entry.primary)
							.map(entry => (
								<li key={entry.path} className="flex items-center gap-2 text-[12px]">
									<Icon name="folder" className="h-3.5 w-3.5 flex-shrink-0" />
									<span className="min-w-0 flex-1 truncate" title={entry.path}>
										{entry.path}
									</span>
									{!entry.exists && (
										<span className="flex-shrink-0 text-[10px] text-[var(--color-danger)]">
											{t("sessionInfo.directoryMissing")}
										</span>
									)}
								</li>
							))}
					</ul>
				)}
			</div>

			<div>
				<div className="gui-group-label pb-1">{t("settings.contextWindow2")}</div>
				{usage ? (
					<div>
						<div className="gui-ctx-usage-row">
							<span className="text-[12px] tabular-nums opacity-80">
								{fmtTokens(usage.tokens)} / {fmtTokens(usage.contextWindow)}
							</span>
							<span className="text-[12px] tabular-nums opacity-70">{Math.round(usage.percent)}%</span>
						</div>
						<div className="gui-ctx-usage-track">
							<div
								className={`gui-ctx-usage-bar${usage.percent > 90 ? " gui-ctx-usage-bar--hot" : ""}`}
								style={{ width: barWidth(usage.percent) }}
							/>
						</div>
					</div>
				) : (
					<p className="m-0 text-[12px] text-[var(--color-text-faint)]">
						{usageUnavailable ? t("sessionInfo.unavailable") : t("sessionInfo.loading")}
					</p>
				)}
			</div>

			<div>
				<div className="gui-group-label pb-1">{t("sessionInfo.tokens")}</div>
				{tokenUsage ? (
					<dl className="m-0 grid grid-cols-2 gap-1 text-[12px]">
						<TokenRow label={t("sessionInfo.input")} value={fmtTokens(tokenUsage.input)} />
						<TokenRow label={t("sessionInfo.output")} value={fmtTokens(tokenUsage.output)} />
						<TokenRow label={t("sessionInfo.cacheRead")} value={fmtTokens(tokenUsage.cacheRead)} />
						<TokenRow label={t("sessionInfo.cacheWrite")} value={fmtTokens(tokenUsage.cacheWrite)} />
						<TokenRow label={t("sessionInfo.total")} value={fmtTokens(tokenUsage.totalTokens)} />
						<TokenRow label={t("sessionInfo.spend")} value={fmtCost(tokenUsage.cost)} />
						{tokenUsage.cacheHitRate !== null ? (
							<TokenRow label={t("sessionInfo.cacheHitRate")} value={`${tokenUsage.cacheHitRate.toFixed(1)}%`} />
						) : null}
					</dl>
				) : (
					<p className="m-0 text-[12px] text-[var(--color-text-faint)]">
						{usageUnavailable ? t("sessionInfo.unavailable") : t("sessionInfo.loading")}
					</p>
				)}
			</div>
		</div>
	);
}

function TokenRow({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="flex items-baseline justify-between gap-2">
			<dt className="m-0 text-[var(--color-text-faint)]">{label}</dt>
			<dd className="m-0 tabular-nums">{value}</dd>
		</div>
	);
}
