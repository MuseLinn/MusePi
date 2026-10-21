/**
 * 把 musepi 主题 token 解析成标注 overlay 能直接用的具体颜色字符串。
 *
 * overlay 渲染在我们不控制的页面内部,拿不到我们的 CSS 变量(那页面有它
 * 自己的 `:root`);token 也可能是任意色彩空间,直接给字符串拼 alpha 后缀
 * 不安全。两个问题用同一个办法解决:探针元素带上 token,浏览器算出的
 * computed style 永远是 overlay 可以原样使用的具体颜色。
 */
import type { AnnotationOverlayTheme } from "./overlay";

const FALLBACK: AnnotationOverlayTheme = {
	colorScheme: "dark",
	primary: "rgb(88, 101, 242)",
	primarySoft: "rgba(88, 101, 242, 0.16)",
	primaryFaint: "rgba(88, 101, 242, 0.10)",
	primaryContrast: "rgb(255, 255, 255)",
	surface: "rgb(24, 24, 28)",
	surfaceElevated: "rgb(32, 32, 38)",
	glassSurface: "rgba(32, 32, 38, 0.62)",
	glassFilter: "blur(24px) saturate(1.8)",
	border: "rgba(255, 255, 255, 0.14)",
	text: "rgb(236, 236, 240)",
	mutedText: "rgba(236, 236, 240, 0.62)",
};

type Probe = {
	readonly read: (value: string) => string;
	readonly readVariable: (name: string) => string;
	readonly dispose: () => void;
};

const createProbe = (): Probe | null => {
	if (typeof document === "undefined" || !document.body) return null;
	const element = document.createElement("div");
	element.setAttribute("aria-hidden", "true");
	element.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none";
	document.body.appendChild(element);
	return {
		read: (value: string): string => {
			element.style.backgroundColor = "";
			element.style.backgroundColor = value;
			const resolved = window.getComputedStyle(element).backgroundColor;
			return resolved && resolved !== "rgba(0, 0, 0, 0)" ? resolved : "";
		},
		readVariable: (name: string): string =>
			window.getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
		dispose: () => element.remove(),
	};
};

/**
 * 读实时主题。探测失败也返回一套可用色板 —— 缺一个 token 绝不能把 overlay
 * 留成在页面上看不见。
 */
export const resolveAnnotationOverlayTheme = (colorScheme: "light" | "dark"): AnnotationOverlayTheme => {
	const probe = createProbe();
	if (!probe) return { ...FALLBACK, colorScheme };

	try {
		const read = (token: string, fallback: string): string => probe.read(`var(${token})`) || fallback;
		const mix = (token: string, percent: number, fallback: string): string =>
			probe.read(`color-mix(in srgb, var(${token}) ${percent}%, transparent)`) || fallback;

		const blur = probe.readVariable("--gui-glass-blur") || "24px";
		const saturation = probe.readVariable("--gui-glass-saturate") || "180%";
		const primary = read("--accent", FALLBACK.primary);
		// 主色底上的文字:按主色亮度选白或深灰。
		const primaryContrast = ((): string => {
			const channels =
				primary
					.match(/[\d.]+/g)
					?.slice(0, 3)
					.map(Number) ?? [];
			if (channels.length < 3) return FALLBACK.primaryContrast;
			const luminance = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
			return luminance > 0.55 ? "rgb(24, 24, 28)" : "rgb(255, 255, 255)";
		})();

		return {
			colorScheme,
			glassSurface: read("--glass-bg", "") || mix("--bg-raised", 62, FALLBACK.glassSurface),
			glassFilter: `blur(${blur}) saturate(${saturation})`,
			primary,
			primarySoft: mix("--accent", 16, FALLBACK.primarySoft),
			primaryFaint: mix("--accent", 10, FALLBACK.primaryFaint),
			primaryContrast,
			surface: read("--bg", FALLBACK.surface),
			surfaceElevated: read("--bg-raised", FALLBACK.surfaceElevated),
			border: read("--border", FALLBACK.border),
			text: read("--fg", FALLBACK.text),
			mutedText: read("--fg-muted", FALLBACK.mutedText),
		};
	} catch {
		return { ...FALLBACK, colorScheme };
	} finally {
		probe.dispose();
	}
};
