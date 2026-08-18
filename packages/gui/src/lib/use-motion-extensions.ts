import { useEffect } from "react";
import type { RpcClient } from "./rpc";
import { useExtensionRegistry } from "./slot-host";

/**
 * Motion-pack injection (extension center → GUI motion).
 *
 * Consumes the shared useExtensionRegistry singleton (10s poll +
 * extensions.changed instant refresh — no own polling), filters active
 * `gui-motion` packs and injects each pack's css as a <style> element at
 * the END of <head> — the built-in stylesheet always loads before them, so
 * same-name keyframes and the --gui-motion-* tokens are naturally
 * overridden (later wins). Disabled or vanished packs have their <style>
 * removed on the next data change.
 *
 * Order stability: packs are applied sorted by id so the override order
 * (and thus same-name keyframe precedence between packs) is deterministic.
 * Content drift (pack file edited) is picked up as a textContent swap.
 */
const STYLE_ATTR = "data-ext-motion";

export function useMotionExtensions(rpc: RpcClient | null): void {
	const data = useExtensionRegistry(rpc);
	// 数据变化 → 重放注入(data 变更时保留旧样式直到新内容就绪,避免
	// 异步 fs.read 期间的闪烁间隙;卸载/rpc 切换才整体移除)。
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const packs = (data?.extensions ?? [])
			.filter(e => e.kind === "gui-motion" && e.state === "active")
			.sort((a, b) => a.id.localeCompare(b.id));

		void (async () => {
			const desired = new Map<string, string>();
			for (const pack of packs) {
				try {
					const file = await rpc.request<{ content: string | null }>("fs.read", {
						path: pack.path,
					});
					if (file?.content) desired.set(pack.id, file.content);
				} catch {
					// Unreadable pack — skip (keeps the UI alive).
				}
			}
			if (!alive) return;

			const seen = new Set<string>();
			for (const el of [...document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTR}]`)]) {
				const id = el.getAttribute(STYLE_ATTR);
				if (!id) continue;
				seen.add(id);
				const css = desired.get(id);
				if (css === undefined) {
					el.remove();
				} else if (el.textContent !== css) {
					el.textContent = css;
				}
			}
			for (const [id, css] of desired) {
				if (seen.has(id)) continue;
				const el = document.createElement("style");
				el.setAttribute(STYLE_ATTR, id);
				el.textContent = css;
				document.head.appendChild(el);
			}
		})();

		return () => {
			alive = false;
		};
	}, [rpc, data]);

	// 卸载或 rpc 切换:移除所有注入的 motion 样式。
	useEffect(() => {
		return () => {
			for (const el of [...document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTR}]`)]) {
				el.remove();
			}
		};
	}, [rpc]);
}
