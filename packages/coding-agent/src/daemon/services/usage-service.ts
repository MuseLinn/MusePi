import type { AuthStorage, DisabledCredentialSummary, UsageReport } from "@musepi/pi-ai";
import {
	collectStoredAccounts,
	collectUnreportedAccounts,
	computeReloginDeadlines,
	isActionableDisable,
	selectReportableAccounts,
} from "../usage-shared";
import type { DaemonService } from "./types";

/**
 * UsageService — 订阅用量面板（L2 宿主服务，P1 首批抽取）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：RPC `usage.reports`（可选 sessionId；TUI /usage parity）。
 * - 输出：用量报告池 + 面板 gap 上下文（未上报账户/禁用凭据墓碑/
 *   re-login 期限）+ 可选 activeAccount（仅会话路径）。
 * - 生命周期：无状态，无 start/stop 副作用；凭据再校验为 best-effort，
 *   不向上抛。
 *
 * 从 server.ts 巨型 switch 的 `usage.reports` case 原样搬移
 * （P1 纪律：纯搬移不改行为，docs/review/0.5.0-m2-daemon-host-layering.md §5）。
 * 会话/注册表访问以结构接口注入（host access），保持服务对
 * DaemonSessionHost 无传递依赖、可单测。
 */

/** 活跃会话的用量相关切面（结构类型，避免 import DaemonSessionHost）。 */
export interface UsageLiveSession {
	agentSession: {
		sessionId: string;
		model?: { provider?: string } | undefined;
		fetchUsageReports(): Promise<UsageReport[] | null | undefined>;
		modelRegistry: { authStorage: AuthStorage };
	};
}

export interface UsageRegistryAccess {
	authStorage: AuthStorage;
	getProviderBaseUrl?(provider: string): string | undefined;
}

export interface UsageServiceHostAccess {
	get(sessionId: string): UsageLiveSession | undefined;
	ensureRegistry(): Promise<UsageRegistryAccess | null>;
}

export interface UsageReportsParams {
	sessionId?: string;
}

export interface UsageReportsResult {
	reports: UsageReport[];
	unreportedAccounts: ReturnType<typeof collectUnreportedAccounts>;
	disabledCredentials: DisabledCredentialSummary[];
	reloginDeadlines: ReturnType<typeof computeReloginDeadlines>;
	activeAccount?: { provider: string; accountId?: string; email?: string };
}

export class UsageService implements DaemonService {
	readonly key = "usage";
	readonly routes = { "usage.reports": "reports" } as const;

	readonly #host: UsageServiceHostAccess;

	constructor(host: UsageServiceHostAccess) {
		this.#host = host;
	}

	async reports(params: UsageReportsParams): Promise<UsageReportsResult> {
		const live = params.sessionId ? this.#host.get(params.sessionId) : undefined;
		if (params.sessionId && !live) throw new Error("No active session");
		// TUI /usage parity coverage: the report pool plus every gap the text
		// panel shows — ○ accounts with no usage data, ✗ disabled credential
		// tombstones, ⚠ OAuth re-login deadlines. Attribution and selection are
		// shared with the TUI (daemon/usage-shared.ts) so the two surfaces
		// can't drift apart.
		const gapContext = async (storage: AuthStorage, reports: UsageReport[]) => {
			const accounts = selectReportableAccounts(
				collectStoredAccounts(storage),
				provider => storage.usageProviderFor(provider) !== undefined,
			);
			// Best-effort revalidate (TUI runUsageCommand parity): a
			// just-logged-in credential must not render as a stale duplicate
			// from the disk cache.
			try {
				await storage.revalidateCredentials();
			} catch {
				// Stale identities beat no output.
			}
			let disabledCredentials: DisabledCredentialSummary[] = [];
			try {
				disabledCredentials = (await storage.listDisabledCredentials()).filter(summary =>
					isActionableDisable(summary, accounts),
				);
			} catch {
				// Usage output must not fail because tombstone listing did.
			}
			return {
				unreportedAccounts: collectUnreportedAccounts(reports, accounts),
				disabledCredentials,
				reloginDeadlines: computeReloginDeadlines(accounts, Date.now()),
			};
		};
		if (!live) {
			// Session-less path (empty-state composer): bootstrap the
			// daemon-level registry like models.list / auth.list do and fetch
			// from its auth storage. The antigravity sandbox special-case is
			// session-settings-driven, so it stays on the session path.
			const registry = await this.#host.ensureRegistry();
			if (!registry) throw new Error("No model registry yet");
			const reports =
				(await registry.authStorage.fetchUsageReports({
					baseUrlResolver: provider => registry.getProviderBaseUrl?.(provider),
				})) ?? [];
			const gaps = await gapContext(registry.authStorage, reports);
			return { reports, ...gaps };
		}
		const reports = (await live.agentSession.fetchUsageReports()) ?? [];
		const gaps = await gapContext(live.agentSession.modelRegistry.authStorage, reports);
		// TUI /usage parity: resolve the credential this session is actually
		// using so the GUI can mark the active account (●) the way the TUI
		// panel does.
		const provider = live.agentSession.model?.provider;
		let activeAccount: UsageReportsResult["activeAccount"];
		if (provider) {
			const identity = live.agentSession.modelRegistry.authStorage.getOAuthAccountIdentity(
				provider,
				live.agentSession.sessionId,
			);
			if (identity) {
				activeAccount = {
					provider,
					...(identity.accountId ? { accountId: identity.accountId } : {}),
					...(identity.email ? { email: identity.email } : {}),
				};
			}
		}
		return { reports, ...gaps, ...(activeAccount ? { activeAccount } : {}) };
	}
}
