import type { ComposerKey } from "../zh-CN/composer.js";

export const composer = {
	// ── Composer ──────────────────────────────────────────────────────────────
	"type your response…": "Type your response…",
	"read-only session — watching only": "Read-only session — watching only",
	"prompt the host agent…": "Prompt the host agent…",
	"waiting for session…": "Waiting for session…",
	"submit response": "Submit response",
	"send (Enter)": "Send (Enter)",
	"working active": "Working",
	"stop turn": "Stop",
	"stop the current turn": "Stop the current turn",
	"compact context": "Compact context",
	"compacting…": "Compacting…",
	"stop compaction": "Stop compaction",
	"compaction failed": "Compaction failed",
	"retry last turn": "Retry last turn",
	"nothing to retry": "Nothing to retry",
	"mark in progress": "Mark in progress",
	"abandon task": "Abandon task",
	"remove task": "Remove task",
	"add a task…": "Add a task…",
	"view-only": "View-only",

	// ── Ask editor ────────────────────────────────────────────────────────────
	"(Recommended)": "(Recommended)",
	recommended: "Recommended",
	multi: "Multi",
	"no selection": "No selection",
	"auto-selected after timeout — not a user choice": "Auto-selected after timeout — not a user choice",
	"select multiple — choose each option, then pick Next": "Select multiple — choose each option, then pick Next",
	Next: "Next",
	"cancel ask": "Cancel",

	// ── Slash commands (composer / TUI parity) ─────────────────────────
	"unknown slash command": "Unknown slash command",
	"this command only works in the terminal": "This command only works in the terminal",
	"skill not found": "Skill not found",
	"slash command failed": "Slash command failed",
	// ── Bash commands (! / !! composer, TUI parity) ────────────────────
	"bash command failed": "Bash command failed",
	"bash command cancelled": "Bash command cancelled",
	"bash exited with code {code} ({lines} lines)": "Bash exited with code {code} ({lines} lines)",
	"bash output excluded from context": "Bash output excluded from context",
	cancelled: "Cancelled",
	"show all": "Show all",
	lines: "Lines",

	// ── Long text paste gate (TUI large-paste parity) ─────────────────
	"Pasted {lines} lines ({chars} chars)": "Pasted {lines} lines ({chars} chars)",
	"discard paste": "Discard paste",
	"paste inline": "Paste inline",
	"wrap as attachment": "Wrap as attachment",
	"wrap as code block": "Wrap as code block",
	"attach as file": "Attach as file",
} as const satisfies Record<ComposerKey, string>;
