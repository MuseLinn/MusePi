/** `settings.compaction` English dictionary, checked complete against the zh key set. */
import type { SettingsCompactionKey } from "../zh-CN/settings-compaction.js";

export const settingsCompaction = {
	"settings.compaction.group.core": "Compaction",
	"settings.compaction.group.behavior": "Compaction Behavior",
	"settings.compaction.group.limits": "Compaction Limits",
	"settings.context.group.experimental": "Experimental",

	"settings.compaction.autoCompact.title": "Auto-Compact",
	"settings.compaction.autoCompact.desc": "Compact the conversation automatically when the context nears its limit.",

	"settings.compaction.threshold.title": "Compaction Threshold",
	"settings.compaction.threshold.desc":
		"Share of the context window that triggers compaction. Default derives the trigger from reserved headroom, which varies with window size; a percentage behaves the same on every model.",
	"settings.compaction.threshold.option.default": "Default",
	"settings.compaction.threshold.option.default.desc": "Derive the trigger from reserved headroom",

	"settings.compaction.tokenLimit.title": "Fixed Token Limit",
	"settings.compaction.tokenLimit.desc":
		"Optional absolute cap; overrides the percentage. Use it to keep context below the model's physical window (premium long-context pricing or attention degradation). Set to Default to return to the percentage.",
	"settings.compaction.tokenLimit.option.default": "Default",
	"settings.compaction.tokenLimit.option.default.desc": "Use percentage-based threshold",
	"settings.compaction.tokenLimit.option.25k": "25K",
	"settings.compaction.tokenLimit.option.25k.desc": "1/8 of a 200K window",
	"settings.compaction.tokenLimit.option.50k": "50K",
	"settings.compaction.tokenLimit.option.50k.desc": "1/4 of a 200K window",
	"settings.compaction.tokenLimit.option.100k": "100K",
	"settings.compaction.tokenLimit.option.100k.desc": "1/2 of a 200K window",
	"settings.compaction.tokenLimit.option.150k": "150K",
	"settings.compaction.tokenLimit.option.150k.desc": "3/4 of a 200K window",
	"settings.compaction.tokenLimit.option.190k": "190K",
	"settings.compaction.tokenLimit.option.190k.desc":
		"Just below the point where some providers double the long-context price",
	"settings.compaction.tokenLimit.option.200k": "200K",
	"settings.compaction.tokenLimit.option.200k.desc": "Full standard context window",
	"settings.compaction.tokenLimit.option.300k": "300K",
	"settings.compaction.tokenLimit.option.300k.desc": "Large context window",
	"settings.compaction.tokenLimit.option.500k": "500K",
	"settings.compaction.tokenLimit.option.500k.desc": "Very large context window",

	"settings.compaction.methodOrder.title": "Compaction Method Order",
	"settings.compaction.methodOrder.desc":
		"Try these methods in order; if one is unavailable or failed, the next one runs.",
	"settings.compaction.method.remote.title": "OpenAI server compaction",
	"settings.compaction.method.remote.desc":
		"Use provider-native OpenAI-compatible server compaction when the active route supports it.",
	"settings.compaction.method.snapcompact.title": "Snapcompact",
	"settings.compaction.method.snapcompact.desc":
		"Archive history onto dense bitmap images the active vision model reads back; no LLM call.",
	"settings.compaction.method.handoff.title": "Handoff document",
	"settings.compaction.method.handoff.desc":
		"Generate a handoff document and continue from it as the compaction summary.",
	"settings.compaction.method.soft.title": "Summary compaction",
	"settings.compaction.method.soft.desc":
		"Summarize in place with a compaction model without using server compaction.",
	"settings.compaction.method.shake.title": "Prune heavy content",
	"settings.compaction.method.shake.desc": "Drop recoverable heavy content in place without an LLM call.",

	"settings.compaction.midTurn.title": "Mid-Turn Compaction",
	"settings.compaction.midTurn.desc":
		"Check the threshold between tool steps, before the next model request; subagents always check, because their whole task is one turn.",

	"settings.compaction.backgroundPre.title": "Background Pre-Compaction",
	"settings.compaction.backgroundPre.desc":
		"Summarize in the background as the threshold approaches, then splice the ready result in, so compaction adds no wait.",

	"settings.compaction.remoteV2.title": "Remote Compaction V2",
	"settings.compaction.remoteV2.desc": "Stream compaction responses on models that support server-side compaction.",

	"settings.compaction.handoffDocs.title": "Save Handoff Docs",
	"settings.compaction.handoffDocs.desc":
		"With the Handoff method, also save the generated handoff document as Markdown.",

	"settings.compaction.supersedeReads.title": "Prune Superseded Reads",
	"settings.compaction.supersedeReads.desc":
		"When a file is read again, drop the older read result (cache-aware; runs every turn).",

	"settings.compaction.dropUseless.title": "Prune Empty Results",
	"settings.compaction.dropUseless.desc":
		"After a tool result is consumed, drop results that found nothing or timed out (cache-aware).",

	"settings.compaction.perModelEnabled.title": "Per-Model Limits",
	"settings.compaction.perModelEnabled.desc":
		"Let per-model entries replace the global threshold for the models they name.",

	"settings.compaction.perModel.title": "Per-Model Thresholds",
	"settings.compaction.perModel.desc":
		"Keys are `provider/model-id` or a `provider/*` prefix; a number scales the percentage against that base, `f90000` is an exact trigger, and `80%` replaces the percentage. `{}` applies no override.",

	"settings.compaction.notesBacked.title": "Notes-backed context windows (experimental)",
	"settings.compaction.notesBacked.desc": "Keep persistent notes and searchable raw history across context windows.",

	"settings.compaction.idle.title": "Idle Compaction",
	"settings.compaction.idle.desc": "Compact in the background when the session is idle and still above the threshold.",

	"settings.compaction.idleThreshold.title": "Idle Threshold",
	"settings.compaction.idleThreshold.desc":
		"Token count that idle compaction must exceed. It is separate from the normal trigger.",
	"settings.compaction.idleThreshold.option.100k": "100K",
	"settings.compaction.idleThreshold.option.200k": "200K",
	"settings.compaction.idleThreshold.option.300k": "300K",
	"settings.compaction.idleThreshold.option.400k": "400K",
	"settings.compaction.idleThreshold.option.500k": "500K",
	"settings.compaction.idleThreshold.option.600k": "600K",
	"settings.compaction.idleThreshold.option.700k": "700K",
	"settings.compaction.idleThreshold.option.800k": "800K",
	"settings.compaction.idleThreshold.option.900k": "900K",

	"settings.compaction.idleDelay.title": "Idle Compaction Delay",
	"settings.compaction.idleDelay.desc":
		"How long to wait while idle; with a 1-hour prompt cache, compaction runs just before the cache expires.",
	"settings.compaction.idleDelay.option.1m": "1 minute",
	"settings.compaction.idleDelay.option.2m": "2 minutes",
	"settings.compaction.idleDelay.option.5m": "5 minutes",
	"settings.compaction.idleDelay.option.10m": "10 minutes",
	"settings.compaction.idleDelay.option.30m": "30 minutes",
	"settings.compaction.idleDelay.option.1h": "1 hour",

	"settings.compaction.editor.title": "Edit per model",
	"settings.compaction.editor.model": "Model",
	"settings.compaction.editor.pick": "Pick a model",
	"settings.compaction.editor.value": "Trigger",
	"settings.compaction.editor.save": "Save",
	"settings.compaction.editor.remove": "Remove",
	"settings.compaction.editor.empty": "No per-model override yet.",
	"settings.compaction.editor.invalid":
		"Use `provider/model-id` or `provider/*`; the value is a token count, `f90000` or `80%`.",
	"settings.compaction.editor.hint": "Save from the fields above; `{}` means no override.",
} satisfies Record<SettingsCompactionKey, string>;
