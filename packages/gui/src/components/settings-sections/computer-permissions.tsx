import { t, type TranslationKey } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { openExternalUrl } from "../../lib/electron";
import type { RpcClient } from "../../lib/rpc";

/**
 * macOS computer-use 权限面板:三项权限(屏幕录制/辅助功能/输入监控)+
 * 授权跳转(系统设置深链)。Kimi Work 权限引导弹窗的设置面板版。
 * 非 macOS(后端不可用)渲染空节点。
 */
export type ComputerPermissionKind = "capture" | "ax" | "input";

export interface ComputerPermissionRow {
	kind: ComputerPermissionKind;
	state: string; // DesktopCapabilities.capturePermission / axPermission / inputPermission
	active: boolean; // DesktopCapabilities.capture / ax / input
}

/** macOS 系统设置深链:Privacy 面板各权限 tab。 */
const SYSTEM_PREFERENCE_URLS: Record<ComputerPermissionKind, string> = {
	capture: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	ax: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	input: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

const PERMISSION_META: Record<
	ComputerPermissionKind,
	{ labelKey: TranslationKey; descriptionKey: TranslationKey; icon: string }
> = {
	capture: { labelKey: "screen recording", descriptionKey: "permission screen recording description", icon: "camera" },
	ax: { labelKey: "accessibility", descriptionKey: "permission accessibility description", icon: "key" },
	input: { labelKey: "input monitoring", descriptionKey: "permission input description", icon: "key" },
};

interface Props {
	rpc: RpcClient | null;
	/** 实时刷新钩子:首次挂载 + 授权跳转后各触发一次。 */
	onRefreshTick?: () => void;
}

/** 从 DesktopCapabilities 提取权限行(非 macOS 后端返回空,面板隐藏)。 */
export function computerPermissionRows(caps: Record<string, unknown> | undefined | null): ComputerPermissionRow[] {
	if (!caps) return [];
	const rows: ComputerPermissionRow[] = [];
	const pick = (kind: ComputerPermissionKind, stateKey: string, activeKey: string): void => {
		const state = caps[stateKey];
		if (typeof state === "string") rows.push({ kind, state, active: caps[activeKey] === true });
	};
	pick("capture", "capturePermission", "capture");
	pick("ax", "axPermission", "ax");
	pick("input", "inputPermission", "input");
	return rows;
}

/** macOS computer-use 权限状态区:三项权限 + 授权跳转(系统设置深链)。 */
export function ComputerPermissionsSection({ rpc, onRefreshTick }: Props): ReactNode {
	const [caps, setCaps] = useState<Record<string, unknown> | null | undefined>(undefined);
	const [opening, setOpening] = useState<ComputerPermissionKind | null>(null);

	const refresh = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<Record<string, unknown>>("computer.capabilities", {})
			.then(setCaps)
			.catch(() => setCaps(null));
		onRefreshTick?.();
	}, [rpc, onRefreshTick]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const rows = computerPermissionRows(caps);
	if (caps === undefined || rows.length === 0) return null;

	const authorize = (kind: ComputerPermissionKind): void => {
		setOpening(kind);
		void openExternalUrl(SYSTEM_PREFERENCE_URLS[kind]).finally(() => setOpening(null));
		// 授权窗口弹出后延迟刷新,让 TCC 状态有时间落盘。
		setTimeout(refresh, 2500);
	};

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-section-title">{t("computer permissions")}</div>
			<p className="gui-settings-row-desc">{t("computer permissions hint")}</p>
			{rows.map(row => {
				const meta = PERMISSION_META[row.kind];
				const granted = row.state === "granted";
				return (
					<div key={row.kind} className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t(meta.labelKey)}</div>
							<div className="gui-settings-row-desc">{t(meta.descriptionKey)}</div>
						</div>
						{granted ? (
							<span className="gui-permission-granted">{t("granted")}</span>
						) : (
							<button
								type="button"
								className="gui-permission-authorize"
								disabled={opening !== null}
								onClick={() => authorize(row.kind)}
							>
								{t("authorize")}
							</button>
						)}
					</div>
				);
			})}
		</div>
	);
}
