import { type TranslationKey, t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import type { RpcClient } from "../lib/rpc";
import type { IconName } from "../vendor/oc-icons";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { type ComputerPermissionKind, computerPermissionRows } from "./settings-sections/computer-permissions";

const SYSTEM_PREFERENCE_URLS: Record<ComputerPermissionKind, string> = {
	capture: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
	ax: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	input: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

const PERMISSION_META: Record<
	ComputerPermissionKind,
	{ labelKey: TranslationKey; descriptionKey: TranslationKey; icon: IconName }
> = {
	capture: {
		labelKey: "screen recording",
		descriptionKey: "permission screen recording description",
		icon: "camera",
	},
	ax: { labelKey: "accessibility", descriptionKey: "permission accessibility description", icon: "eye" },
	input: { labelKey: "input monitoring", descriptionKey: "permission input description", icon: "key" },
} as const;

interface Props {
	rpc: RpcClient | null;
	open: boolean;
	onClose(): void;
}

/**
 * Kimi Work 式 macOS 权限引导弹窗:检测 computer-use 所需权限
 * (屏幕录制/辅助功能/输入监控),未授权项展示授权按钮,点击跳转系统设置。
 */
export function ComputerPermissionsDialog({ rpc, open, onClose }: Props): ReactNode {
	const [caps, setCaps] = useState<Record<string, unknown> | null | undefined>(undefined);
	const [opening, setOpening] = useState<ComputerPermissionKind | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const refresh = useCallback((): void => {
		if (!rpc || !open) return;
		setRefreshing(true);
		void rpc
			.request<Record<string, unknown>>("computer.capabilities", {})
			.then(setCaps)
			.catch(() => setCaps(null))
			.finally(() => setRefreshing(false));
	}, [rpc, open]);

	useEffect(() => {
		if (open) refresh();
	}, [open, refresh]);

	const rows = computerPermissionRows(caps);
	const allGranted = rows.length > 0 && rows.every(row => row.state === "granted");

	const authorize = (kind: ComputerPermissionKind): void => {
		setOpening(kind);
		void openExternalUrl(SYSTEM_PREFERENCE_URLS[kind]).finally(() => setOpening(null));
		setTimeout(refresh, 2500);
	};

	return (
		<DialogFrame open={open} onClose={onClose} label={t("computer permissions")} className="w-[520px] max-w-[92vw]">
			<div className="gui-permissions-dialog">
				<h3 className="gui-permissions-dialog-title">{t("computer permissions overlay title")}</h3>
				<p className="gui-permissions-dialog-desc">{t("computer permissions overlay description")}</p>
				{refreshing && rows.length === 0 ? (
					<div className="gui-permissions-dialog-loading">{t("loading")}</div>
				) : (
					<div className="gui-permission-list">
						{rows.map(row => {
							const meta = PERMISSION_META[row.kind];
							const granted = row.state === "granted";
							return (
								<div key={row.kind} className="gui-permission-row">
									<span className={`gui-permission-icon ${row.kind}`} aria-hidden="true">
										<Icon name={meta.icon} className="h-5 w-5" />
									</span>
									<div className="gui-permission-copy">
										<div className="gui-permission-name">{t(meta.labelKey)}</div>
										<div className="gui-permission-description">{t(meta.descriptionKey)}</div>
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
				)}
				<div className="gui-permissions-dialog-actions">
					{!allGranted && (
						<button type="button" className="gui-btn" onClick={onClose}>
							{t("overlay later")}
						</button>
					)}
					<button type="button" className="gui-btn gui-btn-primary" onClick={onClose}>
						{t("done")}
					</button>
				</div>
				{!allGranted && <div className="gui-permissions-dialog-footer">{t("computer permissions later hint")}</div>}
			</div>
		</DialogFrame>
	);
}
