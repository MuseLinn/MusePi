// ============================================================
// MusePi en-US locale - English source strings for the TUI.
//
// Keys are namespaced ("<domain>.<name>"); values are the English
// text shown for en-US. Regenerated from scripts/i18n-key-migration.json
// (the namespaced-key migration's old-literal -> new-key map); do not
// hand-edit entries that exist in the migration map.
// ============================================================

import type { TranslationMap } from "../index.ts";

export const welcome: TranslationMap = {
	"welcome.copyCodeGrabs.info":
		"`/copy code` grabs the last code block to your clipboard — `/copy cmd` grabs the last shell/python command",
	"welcome.ctrlDCan.info": "Ctrl+D can be used to exit, but with your draft saved!",
	"welcome.didYouKnow.info":
		"Did you know? Each kitty/tmux/cmux/zellij/wezterm split keeps its own session — `musepi -c` resumes the right one",
	"welcome.dropWordUltrathink.info":
		"Drop the word `ultrathink` in your message for harder multi-step reasoning — watch it glow rainbow as you type",
	"welcome.findOutWhich.info": "Find out which model you emotionally abuse the most with `musepi stats`",
	"welcome.forceReadPins.info":
		"`/force read` pins the next turn to one specific tool when the model keeps reaching for the wrong one",
	"welcome.hitCodexRate.info":
		"Hit a Codex rate limit? `/usage reset` spends a saved reset credit to immediately restore your quota",
	"welcome.logSeveralAccounts.info":
		"Log in to several accounts of the same provider — /login again — and musepi load-balances across them automatically",
	"welcome.needCheapNested.info":
		"Need a cheap nested model call? Use `completion(x...)`. Have a big batch of tasks? Ask clanker to use it!",
	"welcome.new": "NEW!",
	"welcome.noLspServers": "No LSP servers",
	"welcome.noNativeTool.desc":
		"No native tool_calling? Inference provider botches parsing them? `PI_DIALECT=glm|kimi|anthropic…` rolls it locally for them!",
	"welcome.noRecentSessions": "No recent sessions",
	"welcome.pairUpLive.desc":
		"Pair up live: `/collab` shares your session through an end-to-end encrypted relay link — a teammate runs `/join <link>` to watch tool calls stream and prompt the agent from their own musepi",
	"welcome.pleaseUseNerdfont": "Please use nerdfont 😭.",
	"welcome.pressAltP.info":
		"Press alt+p (or /switch) to switch provider, and ctrl+p to cycle role models smol -> slow -> etc",
	"welcome.pressCtrlR.info": "Press ctrl+r to search your prompt history and reuse a past message",
	"welcome.pressDrillRunning.info":
		"Press ← ← to drill into a running or finished agent and inspect its tool calls and transcript",
	"welcome.pressShiftTabCycle": "Press shift+tab to cycle through reasoning effort levels",
	"welcome.runMusepiAuth.desc":
		"Run `musepi auth-broker serve` once and every machine pulls live tokens over the wire — refresh keys never leave the host; `musepi auth-gateway` fronts it as a drop-in proxy any OpenAI-compatible client can hit",
	"welcome.sayOrchestrateYour.info":
		"Say `orchestrate` in your message to drive a multi-phase task with parallel subagents — watch it glow as you type",
	"welcome.sayWorkflowzYour.info":
		"Say `workflowz` in your message to drive the task with parallel subagents in eval — watch it glow as you type",
	"welcome.shakeRipsHeavy.desc":
		"`/shake` rips heavy tool results out of context to reclaim tokens without a full /compact — `/shake images` drops just images",
	"welcome.spaghettiCodeTry.info": "Spaghetti code? Try complaining with /omfg",
	"welcome.tip": "Tip: ",
	"welcome.tryStartingYour.info": "Try starting your prompt with a ->, and writing a list (1. Do X, 2. Do Y)",
	"welcome.tryTaskIsolationCreate": "Try task isolation to create CoW worktrees",
	"welcome.turnAdvisorAttach.info":
		"Turn on /advisor to attach a second model that reviews every turn and quietly injects advice",
	"welcome.useTanForkCurrent": "Use /tan to fork the current conversation into a background agent",
	"welcome.welcomeBack": "Welcome back!",
	"welcome.youCanBtwAsk": "You can /btw to ask a side question",
};
