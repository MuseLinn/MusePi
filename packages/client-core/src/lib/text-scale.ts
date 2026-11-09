/**
 * Physical text-scale normalisation for the native shells (bitfun
 * `design-system` "text_scale" parity).
 *
 * A CSS px in an Android WebView is one dp, and a dp is only a fixed fraction
 * of an inch on the density the type ladder was tuned for. The ladder here
 * (15px base) was tuned on the iPhone Pro class, where one logical unit is
 * 1/153.3 inch — a 460 ppi 3x panel. A HUAWEI Mate X7 reports 415.6 xdpi at
 * density 3.125, so its "15" is physically larger than the same 15 on the
 * reference device.
 *
 * The correction is `xdpi / density / 153.3`, clamped, applied to TEXT ONLY:
 * spacing, radii, icon glyphs and control geometry keep their own scale, so
 * correcting density never re-flows the layout. Non-native surfaces keep the
 * factor at 1 — a desktop browser already resolves CSS px against the OS DPI
 * setting, and double-correcting there would be wrong.
 */

/** Reference logical DPI: 460 ppi at 3x (the class the type ladder came from). */
const REFERENCE_LOGICAL_DPI = 153.3;

/** Bounded so a mis-reported xdpi can never wreck the hierarchy. */
const MIN_FACTOR = 0.85;
const MAX_FACTOR = 1.18;

export interface DisplayMetrics {
	xdpi?: number;
	density?: number;
}

/** Pure factor from raw display metrics; 1 when they are unusable. */
export function textScaleFrom(metrics: DisplayMetrics | null | undefined): number {
	const xdpi = metrics?.xdpi ?? 0;
	const density = metrics?.density ?? 0;
	if (!(xdpi > 0) || !(density > 0)) return 1;
	const factor = xdpi / density / REFERENCE_LOGICAL_DPI;
	if (!Number.isFinite(factor)) return 1;
	return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, Number(factor.toFixed(3))));
}

/** CSS custom property the type ladder multiplies by (tokens.css). */
export const TEXT_SCALE_VAR = "--mp-text-scale";

/** Read metrics from the active native shell; null when there is no bridge. */
async function readDisplayMetrics(): Promise<DisplayMetrics | null> {
	const bridge = window.Capacitor?.nativePromise;
	if (typeof bridge !== "function") return null;
	try {
		return await bridge<DisplayMetrics>("Insets", "getDisplayMetrics");
	} catch {
		return null;
	}
}

/**
 * Apply the density correction once at boot. Safe to call anywhere: with no
 * native bridge (browser, Electron guest, HarmonyOS) it leaves the variable
 * unset and the ladder falls back to 1.
 */
export async function applyTextScale(): Promise<void> {
	const metrics = await readDisplayMetrics();
	const factor = textScaleFrom(metrics);
	if (factor === 1) return;
	document.documentElement.style.setProperty(TEXT_SCALE_VAR, String(factor));
}
