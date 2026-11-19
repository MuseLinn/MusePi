import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { DialogFrame } from "../DialogFrame";

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
	onClose,
	onDone,
	autoStart = false,
}: {
	rpc: RpcClient | null;
	/** The MCP server name, e.g. `connector:github`. */
	serverName: string;
	open: boolean;
	onClose(): void;
	onDone(): void;
	/** Start the flow on mount: the caller already chose the device grant. */
	autoStart?: boolean;
}): ReactNode {
	const [flow, setFlow] = useState<DeviceFlowState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);
	const timerRef = useRef<Timer | null>(null);
	const startedRef = useRef(false);

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
		setStarting(true);
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
		} finally {
			setStarting(false);
		}
	}, [poll, rpc, serverName]);

	/**
	 * Auto-start once per mount. The catalog's connect path already decided this
	 * row signs in with a device code, so making the person press a second
	 * "start" button would be asking the same question twice.
	 */
	useEffect(() => {
		if (!open || !autoStart || startedRef.current) return;
		startedRef.current = true;
		void start();
	}, [autoStart, open, start]);

	if (!open) return null;

	/**
	 * Closing the sign-in surface means the person stopped: cancel the pending
	 * flow so a code still being typed elsewhere cannot finish a grant they
	 * walked away from.
	 */
	const dismiss = (): void => {
		if (flow?.status === "pending") {
			void rpc?.request("mcp.oauth.device.cancel", { flowId: flow.flowId }).catch(() => {});
		}
		stop();
		onClose();
	};

	return (
		<DialogFrame
			open={open}
			onClose={dismiss}
			label={t("settings.mcpDeviceTitle")}
			className="gui-dialog--device"
			morphKey={`${flow?.status ?? "idle"}:${Boolean(error)}:${starting}`}
		>
			<div className="gui-connector-detail">
				<div className="gui-connector-detail-head">
					<div className="min-w-0 flex-1">
						<h3 className="gui-settings-page-title">{t("settings.mcpDeviceTitle")}</h3>
						<div className="gui-settings-page-desc">{t("settings.mcpDeviceDesc")}</div>
					</div>
					<button type="button" className="gui-btn" onClick={dismiss}>
						{t("settings.close")}
					</button>
				</div>
				<div className="gui-connector-detail-body">
					{error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}

					{flow === null ? (
						autoStart || starting ? (
							/* First frame = the pending shape: the code row and the action
							 * row already exist, so the code arrives by replacing text
							 * instead of growing the dialog while its shared-surface
							 * transition is still running. */
							<div className="flex flex-col gap-2">
								<div className="text-[13px]">{t("settings.mcpDeviceStarting")}</div>
								<div className="flex items-center gap-1.5">
									<button type="button" className="gui-btn" disabled>
										{t("settings.mcpDeviceOpen")}
									</button>
									<span className="text-[11.5px] text-[var(--color-text-muted)]">
										{t("settings.mcpDeviceWaiting")}
									</span>
								</div>
							</div>
						) : (
							<button type="button" className="gui-btn gui-btn-primary self-start" onClick={() => void start()}>
								{t("settings.mcpDeviceStart")}
							</button>
						)
					) : (
						<div className="flex flex-col gap-2">
							{flow.status === "pending" && (
								<>
									<div className="text-[13px]">{t("settings.mcpDeviceCode", { code: flow.userCode })}</div>
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
			</div>
		</DialogFrame>
	);
}
