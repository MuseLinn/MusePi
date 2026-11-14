import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

/**
 * 会话内设计体系选中态（M3.7b §3.2 生效链路）——Composer 的
 * DesignStyleSelect 接线：
 *
 * - 初始值：从会话头的 projectMetadata 读（GUI 既有读头路径
 *   `creation.metadata.get { sessionId }`，daemon 侧经 view-store 快照头
 *   直读），随会话切换重置重读。
 * - pick：`session.setDesignSystem` RPC（`{ sessionId, designSystemId }`，
 *   null = 清除/跟随既有，选中即写；写后 daemon 重建 system prompt）。
 *   RPC 失败静默——选中态保留本地，下一次 modes 轮询/重进自然对齐。
 */
export function useSessionDesignSystem(
	rpc: RpcClient | null,
	sessionId: string,
	enabled: boolean,
): { designStyle: string | null; pickDesignStyle(id: string | null): void } {
	const [designStyle, setDesignStyle] = useState<string | null>(null);
	// 会话切换 → 从会话头回读 designSystemId（设计会话才需要）。
	useEffect(() => {
		setDesignStyle(null);
		if (!rpc || !sessionId || !enabled) return;
		let alive = true;
		void rpc
			.request<{ metadata: Record<string, unknown> | null }>("creation.metadata.get", { sessionId })
			.then(res => {
				if (!alive) return;
				const id = res?.metadata?.designSystemId;
				setDesignStyle(typeof id === "string" && id ? id : null);
			})
			.catch(() => {
				// 读头失败（daemon 离线/旧版无该方法）：保持未选中。
			});
		return () => {
			alive = false;
		};
	}, [rpc, sessionId, enabled]);

	const pickDesignStyle = useCallback(
		(id: string | null): void => {
			setDesignStyle(id);
			if (!rpc || !sessionId) return;
			void rpc.request("session.setDesignSystem", { sessionId, designSystemId: id }).catch(() => {
				// 写入失败（daemon 离线/RPC 未上线）：本地态保留。
			});
		},
		[rpc, sessionId],
	);
	return { designStyle, pickDesignStyle };
}
