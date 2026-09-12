import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import {
	attachElement,
	entrySrc,
	getHostState,
	type HostWebview,
	persistTabs,
	restoreTabs,
	subscribeHost,
	wireHost,
} from "../lib/managed-browser-host";

/** Guest partition — every managed tab shares it, so logins persist here. */
export const MANAGED_BROWSER_PARTITION = "persist:musepi-managed-browser";

/**
 * 托管浏览器宿主(常驻单例,挂载在 App 根).
 *
 * 页面元素是 DOM 里的 `<webview>`,所以菜单/提示/弹层/拖拽手柄都按普通 z-index
 * 层叠 —— 不再有「原生视图恒在 DOM 之上」带来的让位与隐藏规避。
 *
 * 两条实测约束决定了这里的形状(勿改):
 * 1. **元素永不移动/卸载**:把 `<webview>` 在 DOM 里 reparent 会直接销毁 guest
 *    (元素留在 DOM 成为死壳)。因此宿主是唯一的父节点,标签切换只切 opacity。
 * 2. **隐藏必须保留布局**:`display:none` / 移出视口会让 `capturePage()` 永不返回、
 *    零尺寸只返回空图 —— agent 截图依赖这个合成表面,所以面板关闭时宿主仍按最后
 *    的 rect 挂载,只用 `opacity:0 + pointer-events:none` 隐藏。
 */
export function ManagedBrowserHost(): ReactNode {
	const state = useSyncExternalStore(subscribeHost, getHostState);

	useEffect(() => {
		wireHost();
		restoreTabs();
	}, []);

	useEffect(() => {
		persistTabs();
	}, [state.tabs]);

	// Blank (about:blank) tab: the pane layers its React start page over the
	// slot, and the host sits at the root stacking level — so it must step aside,
	// exactly like the native view used to when the tab was blank.
	const activeBlank = state.tabs.find(tab => tab.id === state.activeId)?.blank ?? true;
	const visible = state.paneVisible && state.rect !== null && !activeBlank;
	// Hidden: keep a real, on-screen box (the guest needs a composited surface).
	const rect = state.rect ?? { x: 0, y: 0, width: 720, height: 480 };

	return (
		<div
			className="gui-managed-host"
			aria-hidden={!visible}
			style={{
				position: "fixed",
				left: rect.x,
				top: rect.y,
				width: rect.width,
				height: rect.height,
				opacity: visible ? 1 : 0,
				pointerEvents: visible ? "auto" : "none",
				// The page fills the pane's rounded slot card, and the guest paints a
				// square surface — so the corners come from clipping HERE (same radius
				// as .gui-browser-slot).
				borderRadius: "var(--radius)",
				overflow: "hidden",
				// Above the right panel (z-850 when maximized) but below the app's
				// dialogs/menus/tooltips — the page is a DOM element now, so a plain
				// z-index is all the maximize case needs.
				zIndex: 900,
				// Viewport-preset fit: the guest keeps the preset layout size and is
				// scaled down (never up) — scaling the HOST, because the page element
				// itself must keep its layout width for a responsive check to mean
				// anything.
				transform: state.rect?.scale && state.rect.scale !== 1 ? `scale(${state.rect.scale})` : undefined,
				transformOrigin: "top left",
			}}
		>
			{state.tabs.map(tab => {
				const active = tab.id === state.activeId;
				return (
					<div
						key={tab.id}
						style={{
							position: "absolute",
							inset: 0,
							// Inactive tabs stay laid out and composited (opacity only) —
							// display:none would cost the agent its screenshot surface.
							opacity: active ? 1 : 0,
							// A child `pointer-events: auto` re-enables hit-testing inside the
							// hidden host — the transparent guest would keep eating the
							// clicks that belong to the pane's start page.
							pointerEvents: visible && active ? "auto" : "none",
						}}
					>
						{/* Never set `display` on the element: Electron's shadow style is
						 * `:host { display: flex }` and the guest's inner iframe takes its
						 * height ONLY from that flex context (`flex: 1 1 auto`, no height
						 * of its own). An inline `display: block` kills the flex layout and
						 * collapses the guest to the 150px replaced-element default — the
						 * element keeps its full box, so the page lays out short over blank
						 * white. Width survives the override (the iframe sets `width: 100%`);
						 * height does not. */}
						<webview
							src={entrySrc(tab.id, tab.url)}
							partition={MANAGED_BROWSER_PARTITION}
							allowpopups
							webpreferences="backgroundThrottling=false"
							ref={el => attachElement(tab.id, el as unknown as HostWebview | null)}
							style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
						/>
					</div>
				);
			})}
		</div>
	);
}
