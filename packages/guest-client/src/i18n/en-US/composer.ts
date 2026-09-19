import type { ComposerKey } from "../zh-CN/composer.js";

export const composer = {
	// ── Composer ──────────────────────────────────────────────────────────────
	"type your response…": "Type your response…",
	"read-only session — watching only": "Read-only session — watching only",
	"ask anything, / for commands, @ for context…": "Ask anything, / for commands, @ for context…",
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

	// ── Image attachments (collab prompt.images; design 「Session 附件流」) ──
	// "add images" lives in the general domain already.
	"take photo": "Take photo",
	"choose from library": "Choose from library",
	"remove attachment": "Remove attachment",
	"attach images hint": "Images resize to a 1568px long edge · JPEG 80% (under 1.5MB sent as-is)",

	// ── General file attachments (fs.write channel; openchamber parity) ─────
	"add attachments": "Add attachments",
	"attachment upload failed": "Attachment upload failed",
	"attachment expired re-add": "Attachment needs re-attaching (session was switched)",
	"no workspace for attachments": "No workspace yet — file attachments need a session workspace",
	"model & thinking": "Model & thinking",
	"host session model": "Current model of the host session",

	// ── Voice input (daemon stt.transcribe; design 「语音四帧」) ──────────────
	// "voice input" / "voice recording stop" / "voice transcribing" /
	// "recording…" live in the settings domain already — reuse, don't duplicate.
	"voice done": "Done",
	"voice discard": "Discard recording",
	"voice failed: {reason}": "Voice input failed: {reason}",
	"voice needs daemon backend": "Voice input needs the daemon backend",
	"voice needs daemon body": "collab-direct sessions can't transcribe voice — connect through the daemon to use it",
	"voice guide ok": "Got it",
	"tts needs daemon backend": "Read-aloud needs the daemon backend",
	// ── SketchPad (Codex 绘画 parity) ─────────────────────────────────────
	sketch: "Sketch",
	"sketch tool select": "Select",
	"sketch tool pen": "Pen",
	"sketch tool eraser": "Eraser",
	"sketch tool line": "Line",
	"sketch tool arrow": "Arrow",
	"sketch tool rect": "Rectangle",
	"sketch tool ellipse": "Ellipse",
	"sketch undo": "Undo",
	"sketch redo": "Redo",
	"sketch clear": "Clear",
	"sketch done": "Done",
	"sketch export light": "Export on a white background",
	"sketch discard title": "Discard this sketch?",
	"sketch discard confirm": "The canvas has unsent content — discarding cannot be undone.",
	// ── Design session style chips (设计稿 08) ────────────────────────────
	"design style": "Design style",
	"design style inherit": "Follow the brief",
	"design style minimal": "Minimal",
	"design style glass": "Glassmorphism",
	"design style editorial": "Editorial",
	"design style neubrutalism": "Neo-brutalism",
	"design style darkneon": "Dark neon",
	"design style hint": "Writes the style baseline into the design brief — send and the agent keeps it",
	"design style brief update {style}":
		'Please update the design brief\'s style baseline to "{style}" and keep the rest of the brief unchanged.',
} as const satisfies Record<ComposerKey, string>;
