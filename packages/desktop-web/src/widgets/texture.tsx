import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";

/**
 * Shared "character noise" texture background (kimi FX/stocks parity):
 * a DOM grid of 8×13px cells whose glyphs form a bright ellipse in the
 * upper-right corner (density falls off with distance), the "K" glyph
 * kept bright. Rebuilds on resize (debounced).
 */
export function CharTexture({ className, seed = 0 }: { className?: string; seed?: number }): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const CW = 8;
		const CH = 13;
		const POOLS: string[][] = [
			[" ", " ", " "],
			["-", "·", " ", " "],
			["+", "/", "(", ")"],
			["(", ")", "*", "/", "+"],
			["*", "▲", "#", "(", ")"],
			["#", "●", "▲", "*", "K"],
		];
		const cls = (b: number, ch: string): string => {
			if (ch === "K") return " gui-char-tex-k";
			if (b <= 1) return " gui-char-tex-1";
			if (b === 2) return " gui-char-tex-2";
			if (b <= 4) return " gui-char-tex-3";
			return " gui-char-tex-4";
		};
		const build = () => {
			const W = el.clientWidth;
			const H = el.clientHeight;
			if (W < 40 || H < 40) return;
			const cols = Math.floor(W / CW);
			const rows = Math.floor(H / CH);
			if (cols <= 0 || rows <= 0) return;
			const frag = document.createDocumentFragment();
			const cx = cols * 0.88;
			const cy = rows * 0.12;
			const rx = cols * 0.34;
			const ry = rows * 0.58;
			let rngState = seed >>> 0 || 7;
			const rng = () => {
				rngState |= 0;
				rngState = (rngState + 0x6d2b79f5) | 0;
				let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
			for (let y = 0; y < rows; y++) {
				const row = document.createElement("div");
				row.className = "gui-char-tex-row";
				for (let x = 0; x < cols; x++) {
					const nx = (x - cx) / rx;
					const ny = (y - cy) / ry;
					let d = 1 - Math.sqrt(nx * nx + ny * ny);
					d += (rng() - 0.5) * 0.12;
					const b = Math.max(0, Math.min(5, Math.floor(d * 6)));
					const pool = POOLS[b];
					const ch = pool[Math.floor(rng() * pool.length)];
					const s = document.createElement("i");
					s.className = `gui-char-tex${cls(b, ch)}`;
					s.textContent = ch;
					row.appendChild(s);
				}
				frag.appendChild(row);
			}
			el.replaceChildren(frag);
		};
		build();
		let t: ReturnType<typeof setTimeout> | null = null;
		const sched = () => {
			if (t) clearTimeout(t);
			t = setTimeout(build, 150);
		};
		const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sched) : null;
		ro?.observe(el);
		window.addEventListener("resize", sched);
		return () => {
			if (t) clearTimeout(t);
			ro?.disconnect();
			window.removeEventListener("resize", sched);
		};
	}, [seed]);

	return (
		<div
			ref={ref}
			className={`gui-char-tex${className ? ` ${className}` : ""}`}
			aria-hidden="true"
			style={{ ["--seed" as string]: seed } as CSSProperties}
		/>
	);
}
