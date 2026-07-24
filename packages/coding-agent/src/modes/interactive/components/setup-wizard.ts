/**
 * MusePi setup wizard — step-by-step first-run configuration.
 *
 * Guides the user through:
 *  1. Provider authentication (delegates to /login)
 *  2. Foreign session scanning (Claude / Codex toggles)
 *  3. Claude Code config import (delegates to /import-claude)
 *  4. Confirmation & apply
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupResult {
	completed: boolean;
	scanClaudeSessions: boolean;
	scanCodexSessions: boolean;
	runClaudeImport: boolean;
}

export interface SetupWizardOptions {
	claudeConfigDetected?: boolean;
	claudeScanEnabled?: boolean;
	codexScanEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Entry labels for the scanning step (cursor-based list)
// ---------------------------------------------------------------------------

interface ScanEntry {
	id: "claude" | "codex";
	label: string;
	detail: string;
}

const SCAN_ENTRIES: ScanEntry[] = [
	{ id: "claude", label: "Claude Code", detail: "~/.claude/projects/" },
	{ id: "codex", label: "Codex (OpenAI)", detail: "~/.codex/state/" },
];

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------

interface WizardStep {
	id: string;
	label: string;
}

const STEPS: WizardStep[] = [
	{ id: "welcome", label: "Welcome" },
	{ id: "provider", label: "Provider" },
	{ id: "scanning", label: "Session Import" },
	{ id: "claude-import", label: "Claude Config" },
	{ id: "summary", label: "Apply" },
];

const TOTAL_STEPS = STEPS.length;

// ---------------------------------------------------------------------------
// Step results
// ---------------------------------------------------------------------------

interface StepResults {
	scanClaudeSessions: boolean;
	scanCodexSessions: boolean;
	runClaudeImport: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export class SetupWizardComponent extends Container {
	private stepIndex = 0;
	private cursorIndex = 0;
	private results: StepResults;
	private border!: DynamicBorder;
	private headerText!: Text;
	private dotsText!: Text;
	private contentContainer!: Container;
	private footerText!: Text;
	private onConfirm: (result: SetupResult) => void;
	private onCancel: () => void;
	private claudeConfigDetected: boolean;

	constructor(opts: SetupWizardOptions, onConfirm: (result: SetupResult) => void, onCancel: () => void) {
		super();

		this.claudeConfigDetected = opts.claudeConfigDetected ?? false;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
		this.results = {
			scanClaudeSessions: opts.claudeScanEnabled ?? false,
			scanCodexSessions: opts.codexScanEnabled ?? false,
			runClaudeImport: false,
		};

		this.buildShell();
		this.renderContent();
	}

	/** Build the persistent outer shell (border, header, dots, footer). Runs once. */
	private buildShell(): void {
		this.border = new DynamicBorder((s) => theme.fg("accent", s));
		this.addChild(this.border);

		this.addChild(new Spacer(1));
		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);
		this.addChild(new Spacer(1));

		this.dotsText = new Text("", 1, 0);
		this.addChild(this.dotsText);
		this.addChild(new Spacer(1));

		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		this.addChild(new Spacer(1));
		this.footerText = new Text("", 1, 0);
		this.addChild(this.footerText);
	}

	private updateShell(): void {
		this.headerText.setText(
			theme.bold(" MusePi Setup ") + theme.fg("muted", `— step ${this.stepIndex + 1} of ${TOTAL_STEPS}`),
		);

		const dots = STEPS.map((s, i) =>
			i === this.stepIndex
				? theme.fg("accent", theme.bold(` ● ${s.label} `))
				: i < this.stepIndex
					? theme.fg("dim", ` ○ ${s.label} `)
					: theme.fg("muted", ` · ${s.label} `),
		).join("");
		this.dotsText.setText(dots);

		const isLast = this.stepIndex === TOTAL_STEPS - 1;
		this.footerText.setText(
			(isLast ? `${keyHint("tui.select.confirm", "Apply")}  ` : `${keyHint("tui.select.confirm", "Next")}  `) +
				keyHint("tui.select.cancel", "Cancel"),
		);
	}

	private renderContent(): void {
		this.updateShell();
		this.contentContainer.clear();

		switch (STEPS[this.stepIndex].id) {
			case "welcome":
				this.buildWelcomeStep();
				break;
			case "provider":
				this.buildProviderStep();
				break;
			case "scanning":
				this.buildScanningStep();
				break;
			case "claude-import":
				this.buildClaudeImportStep();
				break;
			case "summary":
				this.buildSummaryStep();
				break;
		}
	}

	// -- Step 1: Welcome ---------------------------------------------------

	private buildWelcomeStep(): void {
		const lines = [
			theme.bold("Welcome to MusePi!") + theme.fg("muted", "  (muselinn/musepi fork)"),
			"",
			"This quick setup will help you configure MusePi for your workflow.",
			"You can change any of these settings later via",
			`${theme.bold("/settings")} or by editing settings.json directly.`,
			"",
			theme.fg("dim", "We'll walk through:"),
			...STEPS.slice(1).map((s, i) => theme.fg("dim", `  ${i + 1}. ${s.label}`)),
			"",
			theme.fg("muted", "Press Enter to continue, or Esc to cancel setup."),
		];
		this.contentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	// -- Step 2: Provider ---------------------------------------------------

	private buildProviderStep(): void {
		const lines = [
			theme.fg("dim", "MusePi needs an AI provider to work with."),
			"",
			"Options:",
			`  ${theme.bold("API key")}${theme.fg("muted", " — set ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.")}`,
			"  " +
				theme.bold("Subscription") +
				theme.fg("muted", ` — use ${theme.bold("/login")} for Claude Pro/Max or ChatGPT Plus/Pro`),
			`  ${theme.bold("Local model")}${theme.fg("muted", " — run a local llama.cpp server")}`,
			"",
			theme.fg("accent", "To configure now, use /login <provider> or set API keys in your shell."),
			"",
			theme.fg("muted", "Press Enter to continue (you can always run /login later)."),
		];
		this.contentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	// -- Step 3: Session scanning (cursor-based list) -----------------------

	private buildScanningStep(): void {
		const lines: string[] = [
			theme.fg("dim", "MusePi can scan sessions from other AI coding agents"),
			theme.fg("dim", "and show them in the session picker with [source] badges."),
			"",
			theme.fg("muted", "Use ↑/↓ to navigate, Space to toggle, Enter to continue."),
			"",
		];

		for (let i = 0; i < SCAN_ENTRIES.length; i++) {
			const entry = SCAN_ENTRIES[i];
			const checked = entry.id === "claude" ? this.results.scanClaudeSessions : this.results.scanCodexSessions;
			const isCursor = i === this.cursorIndex;
			const prefix = isCursor ? theme.fg("accent", "▸ ") : "  ";
			const checkbox = checked ? theme.fg("accent", "[x]") : "[ ]";
			const name = isCursor ? theme.bold(entry.label) : entry.label;
			lines.push(`  ${prefix} ${checkbox} ${name}  ${theme.fg("dim", entry.detail)}`);
		}

		this.contentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	private toggleCurrentScanEntry(): void {
		const entryId = SCAN_ENTRIES[this.cursorIndex]?.id;
		if (entryId === "claude") {
			this.results.scanClaudeSessions = !this.results.scanClaudeSessions;
		} else if (entryId === "codex") {
			this.results.scanCodexSessions = !this.results.scanCodexSessions;
		}
		this.buildScanningStep();
	}

	private moveCursor(delta: number): void {
		const next = this.cursorIndex + delta;
		if (next >= 0 && next < SCAN_ENTRIES.length) {
			this.cursorIndex = next;
			this.buildScanningStep();
		}
	}

	// -- Step 4: Claude config import ---------------------------------------

	private buildClaudeImportStep(): void {
		if (!this.claudeConfigDetected) {
			const lines = [
				theme.fg("dim", "No Claude Code configuration detected."),
				"",
				theme.fg("muted", "If you use Claude Code, run"),
				theme.bold("/import-claude") + theme.fg("muted", " to import MCP servers and skills."),
			];
			this.contentContainer.addChild(new Text(lines.join("\n"), 1, 0));
			return;
		}

		const c = this.results;
		const lines = [
			theme.fg("dim", "Claude Code configuration found."),
			"",
			theme.bold("Import MCP servers and skills from Claude Code?"),
			"",
			`  ${c.runClaudeImport ? theme.fg("accent", "[x]") : "[ ]"} Yes, import settings`,
			"",
			theme.fg("muted", "You'll be able to select individual items to import."),
			"",
			`You can also run ${theme.bold("/import-claude")} at any time.`,
		];
		this.contentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	// -- Step 5: Summary ----------------------------------------------------

	private buildSummaryStep(): void {
		const c = this.results;
		const changes: string[] = [];

		if (c.scanClaudeSessions) changes.push("Claude Code session scanning enabled");
		if (c.scanCodexSessions) changes.push("Codex session scanning enabled");
		if (c.runClaudeImport && this.claudeConfigDetected) changes.push("Claude Code config will be imported");
		if (changes.length === 0) {
			changes.push(theme.fg("dim", "No changes selected."));
		}

		const lines = [
			theme.bold("Ready to apply."),
			"",
			...changes.map((l) => `  ${theme.fg("accent", "✓")} ${l}`),
			"",
			theme.fg("muted", "Press Enter to apply, or Esc to cancel."),
		];
		this.contentContainer.addChild(new Text(lines.join("\n"), 1, 0));
	}

	// -- Input handling -----------------------------------------------------

	handleInput(keyData: string): void {
		const stepId = STEPS[this.stepIndex].id;
		const kb = getKeybindings();

		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.stepIndex === TOTAL_STEPS - 1) {
				this.onConfirm({ completed: true, ...this.results });
				return;
			}
			this.advance();
			return;
		}

		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveCursor(-1);
			return;
		}

		if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveCursor(1);
			return;
		}

		if (keyData === " ") {
			if (stepId === "scanning") {
				this.toggleCurrentScanEntry();
			}
			if (stepId === "claude-import" && this.claudeConfigDetected) {
				this.results.runClaudeImport = !this.results.runClaudeImport;
				this.buildClaudeImportStep();
			}
			return;
		}
	}

	private advance(): void {
		if (this.stepIndex < TOTAL_STEPS - 1) {
			this.stepIndex++;
			this.cursorIndex = 0;
			this.renderContent();
		}
	}

	dispose(): void {
		// no timers to clean up
	}
}
