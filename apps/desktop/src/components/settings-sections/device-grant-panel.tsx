import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";

/**
 * A device-grant sign-in.
 *
 * Some vendors publish no registration endpoint, so a client cannot obtain a
 * client id on its own and the browser-callback path needs an application the
 * user had to register by hand. The device grant replaces the redirect with a
 * short code: the user opens a page, types the code, and this poll loop
 * waits for the grant.
 */
interface DeviceFlowState {
	flowId: string;
	userCode: string;
	verificationUri: string;
	/** Seconds the server asked to wait between polls. */
	interval: number;
	status: "pending" | "success" | "error";
	error?: string;
}

/**
 * Device-grant login for one server.
 *
 * The poll cadence is the server's: `interval` says how long to wait, and a
 * `slow_down` answer means the poll came too early. The loop stops on the
 * first terminal answer, so a cancelled or expired code stops it too.
 */
export function DeviceGrantPanel({
	rpc,
	serverName,
	open,
	onDone,
}: {
	rpc: RpcClient | null;
	/** The MCP server name, e.g. `connector:github`. */
	serverName: string;
	open: boolean;
	onDone(): void;
}): ReactNode {
	const [flow, setFlow] = useState<DeviceFlowState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const timerRef = useRef<Timer | null>(null);

	const stop = useCallback(() => {
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	useEffect(() => stop, [stop]);

	const poll = useCallback(
		async (flowId: string, interval: number): Promise<void> => {
			const wait = Math.max(1, interval) * 1000;
			timerRef.current = setTimeout(() => {
				void (async () => {
					try {
						const result = await rpc?.request<{
							status: "pending" | "success" | "error";
							error?: string;
							interval?: number;
						}>("mcp.oauth.device.poll", { flowId });
						if (!result) return;
						if (result.status === "success") {
							setFlow(current => (current ? { ...current, status: "success" } : current));
							onDone();
							return;
						}
						if (result.status === "error") {
							setFlow(current => (current ? { ...current, status: "error", error: result.error } : current));
							return;
						}
						await poll(flowId, result.interval ?? interval);
					} catch (pollError) {
						setFlow(current =>
							current
								? {
										...current,
										status: "error",
										error: pollError instanceof Error ? pollError.message : String(pollError),
									}
								: current,
						);
					}
				})();
			}, wait);
		},
		[onDone, rpc],
	);

	const start = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		tapFeedback();
		setError(null);
		try {
			const started = await rpc.request<{
				flowId: string;
				userCode: string;
				verificationUri: string;
				interval: number;
			}>("mcp.oauth.device.start", { name: serverName });
			setFlow({
				flowId: started.flowId,
				userCode: started.userCode,
				verificationUri: started.verificationUri,
				interval: started.interval,
				status: "pending",
			});
			await poll(started.flowId, started.interval);
		} catch (startError) {
			setError(startError instanceof Error ? startError.message : String(startError));
		}
	}, [poll, rpc, serverName]);

	if (!open) return null;

	return (
		<div className="gui-agent-card">
			<div className="text-[12px] font-medium">{t("settings.mcpDeviceTitle")}</div>
			<div className="mb-2 text-[11.5px] text-[var(--color-text-muted)]">{t("settings.mcpDeviceDesc")}</div>

			{error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

			{flow === null ? (
				<button type="button" className="gui-btn gui-btn-primary" onClick={() => void start()}>
					{t("settings.mcpDeviceStart")}
				</button>
			) : (
				<div className="flex flex-col gap-2">
					{flow.status === "pending" && (
						<>
							<div className="text-[12px]">{t("settings.mcpDeviceCode", { code: flow.userCode })}</div>
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									className="gui-btn"
									onClick={() => void openExternalUrl(flow.verificationUri).catch(() => {})}
								>
									{t("settings.mcpDeviceOpen")}
								</button>
								<span className="text-[11.5px] text-[var(--color-text-muted)]">
									{t("settings.mcpDeviceWaiting")}
								</span>
							</div>
						</>
					)}
					{flow.status === "success" && (
						<div className="text-[12px] text-[var(--color-success)]">{t("settings.authorizationDone")}</div>
					)}
					{flow.status === "error" && (
						<div className="text-[12px] text-[var(--color-danger)]">
							{flow.error ?? t("settings.mcpOauthLoginFailed", { error: "" })}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
