import { type ReactNode, useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useExtensionRegistry } from "../lib/slot-host";

/**
 * 积分胶囊 — 状态栏上的「渠道 • 积分余额」读数。
 *
 * 对齐 jet-hub 的 usage badge：插件提供聚合读数（每渠道一行，余额文本 +
 * 到期倒计时），这里每 120 秒轮询一次并渲染**当前选中模型所属渠道**的那行。
 *
 * ## 数据从哪来
 *
 * `auth_hub.pool.badge`（插件 RPC）：余额文本来自池自己的 quota 分发（各渠道
 * 的 wire 形状插件都懂），到期倒计时来自 Auto 的临期探针（同一份 60s 缓存，
 * 不重复打上游）。jet-hub 的铁律在这里同样成立：**失败与 0 分开**——渠道有
 * 错误时显示原因而不是 0，画成 0 会让用户以为额度被清空。
 *
 * ## 什么情况下不渲染
 *
 * - 当前模型不属于任何 auth-hub 渠道（内置 provider 等）；
 * - 该渠道在徽标读数里没有行（池里没有它的账号）；
 * - RPC 不可用或读数失败（静默——徽标是增益信息，不该变成报错源）。
 */

/** One channel row of the badge RPC's response. */
interface BadgeChannel {
	provider: string;
	accounts: number;
	balanceText?: string;
	errors: string[];
	expiryAt?: number;
	expiryText?: string;
}

const POLL_INTERVAL_MS = 120_000;

/** The provider part of a `provider/id` composite. */
function providerOf(modelId: string | null | undefined): string | null {
	if (!modelId) return null;
	const slash = modelId.indexOf("/");
	return slash > 0 ? modelId.slice(0, slash) : null;
}

/** The channel an auth-hub provider id maps to (`auth-hub-codebuddy` → buddy). */
function channelOfProvider(provider: string): string | null {
	if (!provider.startsWith("auth-hub-")) return null;
	const channel = provider.slice("auth-hub-".length);
	// The codebuddy channel's provider id spells the product, not the channel.
	return channel === "codebuddy" ? "buddy" : channel;
}

export function CreditBadge({
	rpc,
	currentModelId,
}: {
	rpc: RpcClient;
	currentModelId: string | null | undefined;
}): ReactNode {
	// The plugin path comes from the SHARED registry (already polled every 10s),
	// not a second poll of our own. ext.call resolves entries by path.
	const registry = useExtensionRegistry(rpc);
	const extensionPath = (registry?.extensions ?? []).find(
		e => e.kind === "extension-module" && e.path.includes("musepi-auth-hub"),
	)?.path;
	const [channels, setChannels] = useState<BadgeChannel[] | null>(null);

	useEffect(() => {
		if (!rpc || !extensionPath) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<unknown>("ext.call", {
					extensionId: extensionPath,
					method: "auth_hub.pool.badge",
					params: {},
				})
				.then(res => {
					if (alive) setChannels((res as { channels?: BadgeChannel[] }).channels ?? []);
				})
				.catch(() => {
					// 增益信息：读不到就什么都不显示，绝不变成报错源。
					if (alive) setChannels(null);
				});
		};
		poll();
		const timer = setInterval(poll, POLL_INTERVAL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, extensionPath]);

	// The badge only answers for auth-hub channels; the extension id must reach
	// the daemon's ext.call, which resolves it by path — resolved lazily below.
	const channel = channelOfProvider(providerOf(currentModelId) ?? "");
	const row = channel ? (channels ?? []).find(c => c.provider === channel) : undefined;
	if (!channel || !row) return null;
	// 失败与 0 分开：有错误时显示「不可用」而不是第一行的 0。
	const failed = row.errors.length >= row.accounts && row.accounts > 0;
	const headline = failed ? "余额不可用" : (row.balanceText ?? "");
	if (headline === "") return null;
	return (
		<span
			className="gui-credit-badge"
			title={row.errors.length > 0 ? row.errors.join("\n") : `${row.provider} · ${row.accounts} 个账号`}
		>
			{headline}
			{row.expiryText !== undefined ? ` · ${row.expiryText}` : ""}
		</span>
	);
}
