import type { ComposerKey } from "../zh-CN/composer.js";

export const composer = {
	// ── Composer ──────────────────────────────────────────────────────────────
	"composer.typeYourResponse": "Type your response…",
	"composer.readOnlySessionWatching": "Read-only session — watching only",
	"composer.askAnythingCommands.info": "Ask anything, / for commands, @ for context…",
	"composer.waitingSession": "Waiting for session…",
	"composer.submitResponse": "Submit response",
	"composer.send": "Send (Enter)",
	"composer.workingActive": "Working",
	"composer.stopTurn": "Stop",
	"composer.stopCurrentTurn": "Stop the current turn",
	"composer.compactContext": "Compact context",
	"composer.compacting": "Compacting…",
	"composer.stopCompaction": "Stop compaction",
	"composer.compactionFailed": "Compaction failed",
	"composer.retryLastTurn": "Retry last turn",
	"composer.nothingRetry": "Nothing to retry",
	"composer.markProgress": "Mark in progress",
	"composer.abandonTask": "Abandon task",
	"composer.removeTask": "Remove task",
	"composer.addTask": "Add a task…",
	"composer.viewOnly": "View-only",

	// ── Ask editor ────────────────────────────────────────────────────────────
	"composer.text": "(Recommended)",
	"composer.recommended": "Recommended",
	"composer.multi": "Multi",
	"composer.noSelection": "No selection",
	"composer.autoSelectedAfterTimeout": "Auto-selected after timeout — not a user choice",
	"composer.selectMultipleChoose.info": "Select multiple — choose each option, then pick Next",
	"composer.next": "Next",
	"composer.cancelAsk": "Cancel",

	// ── Slash commands (composer / TUI parity) ─────────────────────────
	"composer.unknownSlashCommand": "Unknown slash command",
	"composer.commandOnlyWorksTerminal": "This command only works in the terminal",
	"composer.skillNotFound": "Skill not found",
	"composer.slashCommandFailed": "Slash command failed",
	// ── Bash commands (! / !! composer, TUI parity) ────────────────────
	"composer.bashCommandFailed": "Bash command failed",
	"composer.bashCommandCancelled": "Bash command cancelled",
	"composer.bashExitedCodeWithCodeWithLines": "Bash exited with code {code} ({lines} lines)",
	"composer.bashOutputExcludedContext": "Bash output excluded from context",
	"composer.cancelled": "Cancelled",
	"composer.showAll": "Show all",
	"composer.lines": "Lines",

	// ── Long text paste gate (TUI large-paste parity) ─────────────────
	"composer.pastedLinesWithLinesWithChars": "Pasted {lines} lines ({chars} chars)",
	"composer.discardPaste": "Discard paste",
	"composer.pasteInline": "Paste inline",
	"composer.wrapAttachment": "Wrap as attachment",
	"composer.wrapCodeBlock": "Wrap as code block",
	"composer.attachFile": "Attach as file",

	// ── Image attachments (collab prompt.images; design 「Session 附件流」) ──
	// "add images" lives in the general domain already.
	"composer.takePhoto": "Take photo",
	"composer.chooseLibrary": "Choose from library",
	"composer.removeAttachment": "Remove attachment",
	"composer.attachImagesHint": "Images resize to a 1568px long edge · JPEG 80% (under 1.5MB sent as-is)",

	// ── General file attachments (fs.write channel; openchamber parity) ─────
	"composer.addAttachments": "Add attachments",
	"composer.attachmentUploadFailed": "Attachment upload failed",
	"composer.attachmentExpiredReAdd": "Attachment needs re-attaching (session was switched)",
	"composer.noWorkspaceAttachments": "No workspace yet — file attachments need a session workspace",
	"composer.modelThinking": "Model & thinking",
	"composer.hostSessionModel": "Current model of the host session",

	// ── Attachment mention (Kimi desktop parity): chip → token in the
	// textarea, rendered as an accent pill with a hover preview. ──
	"composer.mentionAttachment": "Mention",
	"composer.mentionImageWithN": "Mention image {n}",
	"composer.mentionFileWithN": "Mention file {n}",

	// ── Voice input (daemon stt.transcribe; design 「语音四帧」) ──────────────
	// "voice input" / "voice recording stop" / "voice transcribing" /
	// "recording…" live in the settings domain already — reuse, don't duplicate.
	"composer.voiceDone": "Done",
	"composer.voiceDiscard": "Discard recording",
	"composer.voiceFailedWithReason": "Voice input failed: {reason}",
	"composer.voiceNeedsDaemonBackend": "Voice input needs the daemon backend",
	"composer.voiceNeedsDaemonBody": "collab-direct sessions can't transcribe voice — connect through the daemon to use it",
	"composer.voiceGuideOk": "Got it",
	"composer.ttsNeedsDaemonBackend": "Read-aloud needs the daemon backend",
	// ── SketchPad (Codex 绘画 parity) ─────────────────────────────────────
	"composer.sketch": "Sketch",
	"composer.sketchToolSelect": "Select",
	"composer.sketchToolPen": "Pen",
	"composer.sketchToolEraser": "Eraser",
	"composer.sketchToolText": "Text",
	"composer.sketchToolShapes": "Shapes",
	"composer.sketchToolLine": "Line",
	"composer.sketchToolArrow": "Arrow",
	"composer.sketchToolRect": "Rectangle",
	"composer.sketchToolEllipse": "Ellipse",
	"composer.sketchToolDiamond": "Diamond",
	"composer.sketchToolTriangle": "Triangle",
	"composer.sketchToolStar": "Star",
	"composer.sketchToolHeart": "Heart",
	"composer.sketchThickness": "Thickness",
	"composer.sketchColor": "Color",
	"composer.sketchTextPlaceholder": "Type text…",
	"composer.sketchUndo": "Undo",
	"composer.sketchRedo": "Redo",
	"composer.sketchClear": "Clear",
	"composer.sketchDone": "Done",
	"composer.sketchExportLight": "Export on a white background",
	"composer.sketchDiscardTitle": "Discard this sketch?",
	"composer.sketchDiscardConfirm": "The canvas has unsent content — discarding cannot be undone.",
	// ── Design session style select (M3.7b §3) ───────────────────────────
	"composer.designStyle": "Design style",
	"composer.designStyleInherit": "Follow the brief",
	"composer.designStyleMinimal": "Minimal",
	"composer.designStyleGlass": "Glassmorphism",
	"composer.designStyleEditorial": "Editorial",
	"composer.designStyleNeubrutalism": "Neo-brutalism",
	"composer.designStyleDarkneon": "Dark neon",
	"composer.designStyleHint": "Pick a design system — its brief section joins the session immediately",
	"composer.designSystemRailTitle": "Design systems",
	"composer.designSystemBuiltin": "Built-in",
	"composer.designSystemExtension": "Extension",
	"composer.designSystemMarketCta": "Market",
	"composer.designSystemMarketAria": "Open the capability center marketplace to discover more design systems",
	"composer.designSystemPreviewCta": "Button",
	"composer.designEmptyPlaceholder": "Describe the interface, style and mood you want to design…",

	// ── Attach「＋」sub-pickers (M2-2.6): enabled plugins / workspace files ──
	"composer.plusEnabledPlugins": "Enabled plugins",
	"composer.plusEnabledPluginsDesc": "Insert a plugin name as a context mention",
	"composer.plusWorkspaceFiles": "Workspace files",
	"composer.plusWorkspaceFilesDesc": "Insert a @relative-path file mention",
	"composer.plusPickerSearch": "Search…",
	"composer.plusPickerLoading": "Loading…",
	"composer.plusPickerLoadFailed": "Failed to load",
	"composer.plusPickerEnabledBadge": "Enabled",
	"composer.plusPickerNoPlugins": "No enabled plugins yet",
	"composer.plusPickerNoFiles": "No files in the workspace yet",
	"composer.plusPickerNoResults": "No matching results",
	"composer.plusPickerTruncated": "Showing first {n} — type more to narrow it down",
} as const satisfies Record<ComposerKey, string>;
