/**
 * MusePi welcome page — initial session welcome screen.
 *
 * Two-column layout with vertical divider, line-based rendering
 * (no Container/Text padding to avoid whitespace issues).
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

const MAX_BOX_WIDTH = 100;
const MIN_LEFT = 12;
const MIN_RIGHT = 20;
const PREFERRED_LEFT = 26;

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
		// Welcome is rendered once per session
	}

	render(width: number): string[] {
		const innerW = Math.min(MAX_BOX_WIDTH, Math.max(0, width - 4));
		if (innerW < 8) return [];

		// Can we fit two columns with "LEFT │ RIGHT" separator?
		const hasRight = innerW >= MIN_LEFT + MIN_RIGHT + 3;

		let leftCol: number;
		let rightCol: number;
		if (hasRight) {
			const dualW = innerW - 3; // room for " │ "
			const desiredLeft = Math.min(PREFERRED_LEFT, Math.max(MIN_LEFT, Math.floor(dualW * 0.35)));
			leftCol = Math.min(desiredLeft, dualW - MIN_RIGHT);
			rightCol = Math.max(1, dualW - leftCol);
		} else {
			leftCol = innerW;
			rightCol = 0;
		}

		const v = theme.fg("border", theme.boxRound.vertical);

		// Title
		const title = theme.fg("dim", `\u2514\u2500\u2500 ${APP_NAME} v${VERSION}`);

		// Left column: logo + welcome + model
		const leftLines: string[] = [];
		for (const l of LOGO_LINES) leftLines.push(theme.fg("accent", l));
		leftLines.push("");
		leftLines.push(theme.bold(theme.fg("accent", `Welcome to ${APP_NAME}!`)));
		leftLines.push("");
		leftLines.push(`  \u25CF ${theme.bold(this.currentModel)}`);
		leftLines.push(`    ${theme.fg("dim", this.currentProvider)}`);

		// Right column: tips + recent sessions
		const rightLines: string[] = [];
		rightLines.push(theme.bold(theme.fg("accent", "Tips")));
		rightLines.push(`  ${rawKeyHint("#", "for prompt actions")}`);
		rightLines.push(`  ${rawKeyHint("/", "for commands")}`);
		rightLines.push(`  ${rawKeyHint("!", "to run bash")}`);
		rightLines.push(`  ${rawKeyHint("$", "to run python")}`);
		rightLines.push(`  ${keyHint("app.message.followUp", "to queue follow-up")}`);
		rightLines.push("");
		if (this.recentSessions.length > 0) {
			rightLines.push(theme.bold(theme.fg("accent", "Recent sessions")));
			for (const rs of this.recentSessions.slice(0, 5)) {
				rightLines.push(`  \u25CF ${rs.label} (${rs.timeAgo})`);
			}
		}

		// Merge columns — row() wraps the final lines with outer │ │
		const maxRows = Math.max(leftLines.length, rightLines.length);
		const borderBox: string[] = [title, ""];
		for (let i = 0; i < maxRows; i++) {
			const l = i < leftLines.length ? padFit(leftLines[i], leftCol) : " ".repeat(leftCol);
			if (hasRight) {
				const r = i < rightLines.length ? padFit(rightLines[i], rightCol) : " ".repeat(rightCol);
				borderBox.push(`${l} ${v} ${r}`);
			} else {
				borderBox.push(l);
			}
		}
		borderBox.push("");

		// Footer hint
		borderBox.push(
			theme.fg(
				"dim",
				`${rawKeyHint("#", "command palette")}  ${rawKeyHint("!", "shell")}  ${rawKeyHint("$", "tools")}  ${keyHint("tui.select.cancel", "dismiss")}`,
			),
		);

		// Frame — row() adds │ │ borders around each line
		const out = [topBorder(width, `${APP_NAME} v${VERSION}`)];
		for (const line of borderBox) out.push(row(line, width));
		out.push(bottomBorder(width));
		return out;
	}
}

function padFit(text: string, w: number): string {
	const vw = visibleWidth(text);
	if (vw === w) return text;
	if (vw < w) return text + " ".repeat(w - vw);
	return truncateToWidth(text, w);
}
