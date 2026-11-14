/**
 * 在页面内(guest)执行的脚本 —— 经 `<webview>.executeJavaScript` 注入,跨域安全。
 *
 * 两个面板(托管浏览器面板与旧的回退面板)共用同一份,避免第二份实现漂移。
 */

/** 元素拾取结果。 */
export interface PickedElement {
	tag: string;
	text: string;
	selector: string;
	outerHTML: string;
}

/** 注入式元素拾取器(bitfun/openchamber parity):悬停高亮 + 点击捕获,
 *  返回 {tag, text, selector, outerHTML}。Esc 取消(返回 null)。 */
export const BROWSER_INSPECT_SCRIPT = `(() => {
	const { promise, resolve } = Promise.withResolvers();
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;pointer-events:none;z-index:2147483647;background:rgba(66,133,244,0.15);outline:2px solid #4285f4;display:none;";
	const tip = document.createElement("div");
	tip.style.cssText =
		"position:fixed;pointer-events:none;z-index:2147483647;background:#1a1a1a;color:#fff;font:11px monospace;padding:2px 6px;border-radius:3px;display:none;";
	document.documentElement.appendChild(overlay);
	document.documentElement.appendChild(tip);
	const cssPath = el => {
		if (el.id) return "#" + el.id;
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && parts.length < 6) {
			let part = node.tagName.toLowerCase();
			if (node.className && typeof node.className === "string") {
				part += "." + node.className.trim().split(/\\s+/).slice(0, 3).join(".");
			}
			const parent = node.parentElement;
			if (parent) {
				const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
				if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
			}
			parts.unshift(part);
			node = parent;
		}
		return parts.join(" > ");
	};
	let current = null;
	const cleanup = () => {
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKey, true);
		overlay.remove();
		tip.remove();
	};
	const onMove = e => {
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === overlay || el === tip) return;
		current = el;
		const r = el.getBoundingClientRect();
		overlay.style.display = "block";
		overlay.style.left = r.left + "px";
		overlay.style.top = r.top + "px";
		overlay.style.width = r.width + "px";
		overlay.style.height = r.height + "px";
		tip.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
		tip.style.display = "block";
		tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 160) + "px";
		tip.style.top = e.clientY + 12 + "px";
	};
	const onClick = e => {
		e.preventDefault();
		e.stopPropagation();
		const el = current || document.elementFromPoint(e.clientX, e.clientY);
		cleanup();
		if (!el) return resolve(null);
		resolve({
			tag: el.tagName.toLowerCase(),
			text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
			selector: cssPath(el),
			outerHTML: el.outerHTML.slice(0, 2000),
		});
	};
	const onKey = e => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		cleanup();
		resolve(null);
	};
	document.addEventListener("mousemove", onMove, true);
	document.addEventListener("click", onClick, true);
	document.addEventListener("keydown", onKey, true);
	return promise;
})()`;

/** 读取页面当前文本选区(「就选区提问」用);无选区返回 null。 */
export const BROWSER_ASK_SELECTION_SCRIPT = `(() => {
	const sel = window.getSelection();
	const text = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.toString().replace(/\\r\\n?/g, "\\n").trim() : "";
	if (!text) return null;
	return { text, title: document.title || "" };
})()`;
