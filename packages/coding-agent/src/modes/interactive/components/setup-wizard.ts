/**
 * MusePi setup wizard — first-run configuration.
 *
 * Follows the same TUI pattern as FirstTimeSetupComponent:
 * single update() that clears + rebuilds, → cursor, rawKeyHint navigation.
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface SetupResult {
	completed: boolean;
	scanClaudeSessions: boolean;
	scanCodexSessions: boolean;
	runClaudeImport: boolean;
}

export interface SetupWizardOptions {
	claudeConfigDetected: boolean;
	claudeScanEnabled: boolean;
	codexScanEnabled: boolean;
}

export class SetupWizardComponent extends Container {
	private step: "welcome" | "provider" | "scanning" | "claude-import" | "apply" = "welcome";
	private cursorIndex = 0;
	private scanClaude: boolean;
	private scanCodex: boolean;
	private runImport = false;
	private readonly claudeDetected: boolean;
	private readonly onConfirm: (result: SetupResult) => void;
	private readonly onCancel: () => void;

	constructor(opts: SetupWizardOptions, onConfirm: (result: SetupResult) => void, onCancel: () => void) {
		super();
		this.claudeDetected = opts.claudeConfigDetected;
		this.scanClaude = opts.claudeScanEnabled;
		this.scanCodex = opts.codexScanEnabled;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
		this.update();
	}

	private update(): void {
		this.clear();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Step indicator dots
		const allSteps: SetupWizardComponent["step"][] = ["welcome", "provider", "scanning", "claude-import", "apply"];
		const stepLabels: Record<string, string> = {
			welcome: "Welcome",
			provider: "Provider",
			scanning: "Scanning",
			"claude-import": "Import",
			apply: "Apply",
		};
		const currentIdx = allSteps.indexOf(this.step);
		const dotLine = allSteps
			.map((s, i) => {
				const label = stepLabels[s];
				if (i === currentIdx) return theme.fg("accent", ` ● ${label} `);
				if (i < currentIdx) return theme.fg("dim", ` ○ ${label} `);
				return theme.fg("muted", ` · ${label} `);
			})
			.join("");
		this.addChild(new Text(dotLine, 1, 0));
		this.addChild(new Spacer(1));

		switch (this.step) {
			case "welcome":
				this.renderWelcome();
				break;
			case "provider":
				this.renderProvider();
				break;
			case "scanning":
				this.renderScanning();
				break;
			case "claude-import":
				this.renderClaudeImport();
				break;
			case "apply":
				this.renderApply();
				break;
		}

		this.addChild(new Spacer(1));

		if (this.step === "scanning") {
			// cursor-based list: show navigation + toggle hint
			this.addChild(
				new Text(
					rawKeyHint("↑↓", "navigate") +
						"  " +
						keyHint("tui.select.confirm", "continue") +
						"  " +
						rawKeyHint("Space", "toggle") +
						"  " +
						keyHint("tui.select.cancel", "cancel"),
					1,
					0,
				),
			);
		} else if (this.step === "apply") {
			this.addChild(
				new Text(`${keyHint("tui.select.confirm", "apply")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
			);
		} else {
			this.addChild(
				new Text(`${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
			);
		}

		this.addChild(new DynamicBorder());
	}

	// ── Step renders ──

	private renderWelcome(): void {
		this.addChild(new Text(theme.fg("accent", theme.bold("MusePi Setup — first-run configuration")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "This wizard will help you configure MusePi for your workflow."), 1, 0));
		this.addChild(
			new Text(theme.fg("dim", "You can change any setting later via /settings or settings.json."), 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "We'll walk through:"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  1. AI provider"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  2. Session scanning (Claude Code / Codex)"), 1, 0));
		this.addChild(new Text(theme.fg("muted", "  3. Claude Code config import"), 1, 0));
	}

	private renderProvider(): void {
		this.addChild(new Text(theme.fg("accent", theme.bold("AI Provider")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "MusePi needs an AI provider to work with."), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`  ${theme.bold("API key")}${theme.fg("muted", " — set ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.")}`,
				1,
				0,
			),
		);
		this.addChild(
			new Text(
				`  ${theme.bold("Subscription")}${theme.fg("muted", " — use /login for Claude Pro/Max or ChatGPT Plus/Pro")}`,
				1,
				0,
			),
		);
		this.addChild(
			new Text(`  ${theme.bold("Local model")}${theme.fg("muted", " — run a local llama.cpp server")}`, 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("accent", "Run /login <provider> to authenticate, or set API keys in your shell."), 1, 0),
		);
	}

	private renderScanning(): void {
		this.addChild(new Text(theme.fg("accent", theme.bold("Session Scanning")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("dim", "MusePi can scan and resume sessions from other AI coding agents."), 1, 0),
		);
		this.addChild(new Spacer(1));

		const items: Array<{ label: string; checked: boolean }> = [
			{ label: "Claude Code sessions", checked: this.scanClaude },
			{ label: "Codex sessions", checked: this.scanCodex },
		];

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const sel = i === this.cursorIndex;
			const prefix = sel ? theme.fg("accent", "→ ") : "  ";
			const label = sel ? theme.fg("accent", item.label) : theme.fg("text", item.label);
			const chk = item.checked ? theme.fg("accent", "[x]") : "[ ]";
			this.addChild(new Text(`${prefix}${chk} ${label}`, 1, 0));
		}
	}

	private renderClaudeImport(): void {
		if (!this.claudeDetected) {
			this.addChild(new Text(theme.fg("dim", "No Claude Code configuration found."), 1, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(
					theme.fg("muted", "If you use Claude Code, run /import-claude to import MCP servers and skills."),
					1,
					0,
				),
			);
			return;
		}

		this.addChild(new Text(theme.fg("accent", theme.bold("Claude Code Import")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "Claude Code configuration detected."), 1, 0));
		this.addChild(new Spacer(1));
		const prefix = this.runImport ? theme.fg("accent", "→ ") : "  ";
		const chk = this.runImport ? theme.fg("accent", "[x]") : "[ ]";
		const label = this.runImport
			? theme.fg("accent", "Import MCP servers and skills")
			: "Import MCP servers and skills";
		this.addChild(new Text(`${prefix}${chk} ${label}`, 1, 0));
	}

	private renderApply(): void {
		this.addChild(new Text(theme.fg("accent", theme.bold("Ready to apply")), 1, 0));
		this.addChild(new Spacer(1));

		const changes: string[] = [];
		if (this.scanClaude) changes.push("Claude Code session scanning");
		if (this.scanCodex) changes.push("Codex session scanning");
		if (this.runImport && this.claudeDetected) changes.push("Claude Code config import");

		if (changes.length === 0) {
			this.addChild(new Text(theme.fg("dim", "  No changes selected."), 1, 0));
		} else {
			for (const c of changes) {
				this.addChild(new Text(`  ${theme.fg("accent", "✓")} ${c}`, 1, 0));
			}
		}
	}

	// ── Input ──

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			if (this.step === "scanning") {
				this.cursorIndex = Math.max(0, this.cursorIndex - 1);
				this.update();
			}
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			if (this.step === "scanning") {
				this.cursorIndex = Math.min(1, this.cursorIndex + 1);
				this.update();
			}
		} else if (keyData === " ") {
			if (this.step === "scanning") {
				if (this.cursorIndex === 0) this.scanClaude = !this.scanClaude;
				else this.scanCodex = !this.scanCodex;
				this.update();
			} else if (this.step === "claude-import" && this.claudeDetected) {
				this.runImport = !this.runImport;
				this.update();
			}
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.step === "apply") {
				this.onConfirm({
					completed: true,
					scanClaudeSessions: this.scanClaude,
					scanCodexSessions: this.scanCodex,
					runClaudeImport: this.runImport,
				});
			} else {
				this.step = this.nextStep();
				this.cursorIndex = 0;
				this.update();
			}
		}
	}

	private nextStep(): SetupWizardComponent["step"] {
		const order: SetupWizardComponent["step"][] = ["welcome", "provider", "scanning", "claude-import", "apply"];
		const idx = order.indexOf(this.step);
		return idx < order.length - 1 ? order[idx + 1] : "apply";
	}
}
