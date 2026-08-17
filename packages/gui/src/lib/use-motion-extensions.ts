import { useEffect } from "react";
import type { RpcClient } from "./rpc";

/**
 * Motion-pack injection (extension center → GUI motion).
 *
 * Polls extensions.list for active `gui-motion` packs and injects each
 * pack's css as a <style> element at the END of <head> — the built-in
 * stylesheet always loads before them, so same-name keyframes and the
 * --gui-motion-* tokens are naturally overridden (later wins). Disabled or
 * vanished packs have their <style> removed on the next poll (10s, aligned
 * with the daemon's extensions.list TTL; a toggle flushes the daemon cache
 * so the flip lands within one poll).
 *
 * Order stability: packs are applied sorted by id so the override order
 * (and thus same-name keyframe precedence between packs) is deterministic.
 * Content drift (pack file edited) is picked up as a textContent swap.
 */
const STYLE_ATTR = "data-ext-motion";
const POLL_MS = 10_000;

interface MotionPack {
	id: string;
	kind: string;
	state: string;
	path: string;
}

export function useMotionExtensions(rpc: RpcClient | null): void {
	useEffect(() => {
		if (!rpc) return;
		let alive = true;

		const poll = (): void => {
			void rpc
				.request<{ extensions?: MotionPack[] }>("extensions.list", {})
				.then(async res => {
					if (!alive) return;
					const packs = (res?.extensions ?? [])
						.filter(e => e.kind === "gui-motion" && e.state === "active")
						.sort((a, b) => a.id.localeCompare(b.id));

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
				})
				.catch(() => {});
		};

		poll();
		const timer = setInterval(poll, POLL_MS);
		return () => {
			alive = false;
			clearInterval(timer);
			for (const el of [...document.querySelectorAll<HTMLStyleElement>(`style[${STYLE_ATTR}]`)]) {
				el.remove();
			}
		};
	}, [rpc]);
}
