/**
 * MusePi welcome page — initial session welcome screen.
 *
 * Flat line-array rendering to avoid excessive whitespace from
 * Text component paddingY accumulation.
 */

import { truncateToWidth, visibleWidth } from "@musepi/pi-tui";
import { APP_NAME, VERSION } from "../../../config.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import { bottomBorder, row, topBorder } from "./overlay-box.ts";

export type WelcomeSessionInfo = {
	label: string;
	timeAgo: string;
};

export interface WelcomeOptions {
	currentModel: string;
	currentProvider: string;
	recentSessions?: WelcomeSessionInfo[];
}

const LOGO_LINES = [
	"  \u2580\u2588\u2580\u2580\u2580\u2580\u2580\u2580\u2588\u2580\u2580\u2580\u2588\u2580  ",
	"   \u2558\u2588\u2588    \u2588\u2588     ",
	"    \u2588\u2588    \u2588\u2588     ",
	"    \u2588\u2588    \u2588\u2588     ",
	"   \u2584\u2588\u2588\u2584  \u2584\u2588\u2588\u2584    ",
];

export class WelcomeComponent {
	private currentModel: string;
	private currentProvider: string;
	private recentSessions: WelcomeSessionInfo[];

	constructor(opts: WelcomeOptions) {
		this.currentModel = opts.currentModel;
		this.currentProvider = opts.currentProvider;
		this.recentSessions = opts.recentSessions ?? [];
	}

	setExpanded(_expanded: boolean): void {
		// no-op
	}

	invalidate(): void {
		// Welcome is rendered once per session — nothing to invalidate
	}

	render(width: number): string[] {
		const innerW = width - 4;
		const leftW = innerW < 60 ? innerW : Math.min(38, Math.floor(innerW * 0.45));
		const rightW = innerW - leftW - 1;

		// Left column
		const left: string[] = [];
		left.push(theme.fg("dim", `\u2514\u2500\u2500 ${APP_NAME} v${VERSION}`));
		left.push("");
		for (const l of LOGO_LINES) left.push(theme.fg("accent", l));
		left.push("");
		left.push(theme.bold(theme.fg("accent", `Welcome to ${APP_NAME}!`)));
		left.push("");
		left.push(`  ${theme.fg("accent", "\u25CF")} ${theme.bold(this.currentModel)}`);
		left.push(`    ${theme.fg("dim", this.currentProvider)}`);

		// Right column (tips computed lazily — theme must be initialized first)
		const right: string[] = [];
		right.push(theme.bold(theme.fg("accent", "Tips")));
		const tips = [
			rawKeyHint("#", "for prompt actions"),
			rawKeyHint("/", "for commands"),
			rawKeyHint("!", "to run bash"),
			rawKeyHint("$", "to run python"),
			keyHint("app.message.followUp", "to queue follow-up"),
		];
		for (const t of tips) right.push(`  ${t}`);
		right.push("");
		if (this.recentSessions.length > 0) {
			right.push(theme.bold(theme.fg("accent", "Recent sessions")));
			for (const rs of this.recentSessions.slice(0, 5)) {
				right.push(`  ${theme.fg("accent", "\u25CF")} ${rs.label} (${rs.timeAgo})`);
			}
		}

		// Merge side by side
		const maxRows = Math.max(left.length, right.length);
		const inner: string[] = [];
		for (let i = 0; i < maxRows; i++) {
			const l = i < left.length ? fit(left[i], leftW) : " ".repeat(leftW);
			const r = i < right.length ? fit(right[i], rightW) : "";
			inner.push(innerW >= 60 ? `${l} ${r}` : l);
		}

		// Footer
		if (innerW > 10) inner.push(theme.fg("dim", "\u2500".repeat(innerW)));
		inner.push(
			theme.fg(
				"dim",
				`${rawKeyHint("#", "command palette")}  ${rawKeyHint("!", "shell")}  ${rawKeyHint("$", "tools")}  ${keyHint("tui.select.cancel", "dismiss")}`,
			),
		);

		// Overlay-box frame
		const out = [topBorder(width, `${APP_NAME} v${VERSION}`)];
		for (const line of inner) out.push(row(line, width));
		out.push(bottomBorder(width));
		return out;
	}
}

/** Pad or truncate text to a target visible width, preserving ANSI codes. */
function fit(text: string, w: number): string {
	const vw = visibleWidth(text);
	if (vw === w) return text;
	if (vw < w) return text + " ".repeat(w - vw);
	return truncateToWidth(text, w);
}
