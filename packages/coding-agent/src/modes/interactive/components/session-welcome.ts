/**
 * MusePi welcome page — initial session welcome screen.
 *
 * Branded page shown at session start:
 *   - overlay-box with musepi vX.Y.Z
 *   - Two columns: logo + model (left), tips + recents (right)
 *   - Footer keyboard hints
 */

import { Container, Spacer, Text } from "@musepi/pi-tui";
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

// ── Logo (OMP-style small) ──

const LOGO_LINES = [
	"  \u2580\u2588\u2580\u2580\u2580\u2580\u2580\u2580\u2588\u2580\u2580\u2580\u2588\u2580  ",
	"   \u2558\u2588\u2588    \u2588\u2588     ",
	"    \u2588\u2588    \u2588\u2588     ",
	"    \u2588\u2588    \u2588\u2588     ",
	"   \u2584\u2588\u2588\u2584  \u2584\u2588\u2588\u2584    ",
];

// ── Component ──

export class WelcomeComponent extends Container {
	private currentModel: string;
	private currentProvider: string;
	private recentSessions: WelcomeSessionInfo[];

	constructor(opts: WelcomeOptions) {
		super();
		this.currentModel = opts.currentModel;
		this.currentProvider = opts.currentProvider;
		this.recentSessions = opts.recentSessions ?? [];
		this.rebuild();
	}

	setExpanded(_expanded: boolean): void {
		// No expand/collapse — always shows the full welcome
	}

	private rebuild(): void {
		this.clear();

		// Title bar
		this.addChild(new Text(theme.fg("dim", `\u2514\u2500\u2500 ${APP_NAME} v${VERSION}`), 2, 0));
		this.addChild(new Spacer(1));

		// Two-column layout
		this.renderLeftColumn();
		this.renderRightColumn();

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "\u2500".repeat(76)), 2, 0));
		this.addChild(new Text(this.getFooterHint(), 2, 0));
	}

	private renderLeftColumn(): void {
		let y = 3;
		for (const line of LOGO_LINES) {
			this.addChild(new Text(theme.fg("accent", line), 4, y++));
		}

		y += 1;
		this.addChild(new Text(theme.bold(theme.fg("accent", `Welcome to ${APP_NAME}!`)), 4, y++));
		y += 1;

		this.addChild(new Text(`  ${theme.fg("accent", "\u25CF")} ${theme.bold(this.currentModel)}`, 4, y++));
		this.addChild(new Text(`    ${theme.fg("dim", this.currentProvider)}`, 4, y++));
	}

	private renderRightColumn(): void {
		let y = 3;

		// Tips
		this.addChild(new Text(theme.bold(theme.fg("accent", "Tips")), 38, y++));
		const tips = [
			`${rawKeyHint("#", "for prompt actions")}`,
			`${rawKeyHint("/", "for commands")}`,
			`${rawKeyHint("!", "to run bash")}`,
			`${rawKeyHint("$", "to run python")}`,
			`${keyHint("app.message.followUp", "to queue follow-up")}`,
		];
		for (const t of tips) {
			this.addChild(new Text(`  ${t}`, 38, y++));
		}

		y += 1;

		// Recent sessions
		if (this.recentSessions.length > 0) {
			this.addChild(new Text(theme.bold(theme.fg("accent", "Recent sessions")), 38, y++));
			for (const rs of this.recentSessions.slice(0, 5)) {
				this.addChild(new Text(`  ${theme.fg("accent", "\u25CF")} ${rs.label} (${rs.timeAgo})`, 38, y++));
			}
		}
	}

	private getFooterHint(): string {
		return theme.fg(
			"dim",
			`${rawKeyHint("#", "command palette")}  ${rawKeyHint("!", "shell")}  ${rawKeyHint("$", "tools")}  ${keyHint("tui.select.cancel", "dismiss")}`,
		);
	}

	// ── Render (overlay-box framing) ────────────────────────────────

	override render(width: number): string[] {
		const out: string[] = [];
		out.push(topBorder(width, `${APP_NAME} v${VERSION}`));

		const inner = super.render(width - 4);
		for (const line of inner) out.push(row(line, width));

		out.push(bottomBorder(width));
		return out;
	}
}
