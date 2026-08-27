import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { ComputerPermissionsDialog } from "../ComputerPermissionsDialog";
import { ComputerPermissionsSection } from "./computer-permissions";
import { SchemaTabSection } from "./schema";

/** localStorage dismiss 标记:首次启用 computer 时弹出的权限引导,
 *  用户点"稍后"后不再自动弹出(设置面板仍可手动进入)。 */
const PERMISSIONS_DISMISSED_KEY = "musepi-gui-computer-permissions-dismissed";

/** Settings → 工具: TUI tools-tab parity (available tools/todos/grep &
 *  browser/computer/github/output-limits/execution/discovery/dev groups),
 *  schema driven. macOS computer-use 权限区 + 首次启用引导弹窗(Kimi Work
 *  parity:computer 开启时检测屏幕录制/辅助功能/输入监控,缺失弹窗引导授权)。 */
export function ToolsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [dialogOpen, setDialogOpen] = useState(false);

	// 首次启用 computer 功能时,若权限缺失且用户未 dismiss,弹出权限引导。
	useEffect(() => {
		if (!rpc) return;
		let dismissed = false;
		try {
			dismissed = localStorage.getItem(PERMISSIONS_DISMISSED_KEY) === "1";
		} catch {
			// ignore
		}
		if (dismissed) return;
		let cancelled = false;
		void (async () => {
			const settings = await rpc
				.request<Record<string, unknown>>("settings.get", { keys: ["computer.enabled"] })
				.catch(() => null);
			if (cancelled || settings?.["computer.enabled"] !== true) return;
			const caps = await rpc.request<Record<string, unknown>>("computer.capabilities", {}).catch(() => null);
			if (cancelled || !caps) return;
			const rows = computerPermissionRowsFor(caps);
			if (rows.some(row => row.state !== "granted")) {
				setDialogOpen(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [rpc]);

	const dismiss = (): void => {
		try {
			localStorage.setItem(PERMISSIONS_DISMISSED_KEY, "1");
		} catch {
			// ignore
		}
		setDialogOpen(false);
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("tools")}</h2>
			<ComputerPermissionsSection rpc={rpc} />
			<SchemaTabSection rpc={rpc} tabs={["tools"]} />
			<ComputerPermissionsDialog rpc={rpc} open={dialogOpen} onClose={dismiss} />
		</>
	);
}

/** 弹窗/面板共用:从 DesktopCapabilities 提取权限行(避免重复逻辑)。 */
function computerPermissionRowsFor(caps: Record<string, unknown>): Array<{ kind: string; state: string }> {
	const rows: Array<{ kind: string; state: string }> = [];
	for (const [kind, stateKey] of [
		["capture", "capturePermission"],
		["ax", "axPermission"],
		["input", "inputPermission"],
	] as const) {
		const state = caps[stateKey];
		if (typeof state === "string") rows.push({ kind, state });
	}
	return rows;
}
