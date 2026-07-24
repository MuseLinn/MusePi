// ============================================================
// MusePi stream rules — session wiring (coding-agent).
//
// Rules load from ~/.pi/agent/muselinn-stream-rules.toml (user scope)
// and .pi/muselinn-stream-rules.toml (project scope, wins on same id).
// Per-session fire state (once/cooldownTurns) lives here; the agent
// loop's prepareNextTurnWithContext seam calls
// composeMusepiStreamPrompt before every LLM request.
// ============================================================

import * as fs from "node:fs";
import * as path from "node:path";

import {
	applyStreamRuleInjections,
	createStreamRuleState,
	evaluateStreamRules,
	parseStreamRulesToml,
	type StreamRule,
	type StreamRuleFireState,
} from "@musepi/core/stream-rules/index.js";

const DEBUG = process.env.PI_MUSEPI_STREAM_RULES_DEBUG === "1";

let cachedRules: StreamRule[] | null = null;
let sessionState: StreamRuleFireState | null = null;

function loadRulesFrom(file: string): StreamRule[] {
	try {
		if (!fs.existsSync(file)) return [];
		return parseStreamRulesToml(fs.readFileSync(file, "utf8"));
	} catch {
		return []; // unreadable config never blocks a turn
	}
}

/** User-scope + project-scope rules, project ids shadow user ids. */
export function getMusepiStreamRules(cwd: string): StreamRule[] {
	if (cachedRules) return cachedRules;
	const home =
		process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent");
	const userRules = loadRulesFrom(path.join(home, "muselinn-stream-rules.toml"));
	const projectRules = loadRulesFrom(path.join(cwd, ".pi", "muselinn-stream-rules.toml"));
	const byId = new Map<string, StreamRule>();
	for (const r of userRules) byId.set(r.id, r);
	for (const r of projectRules) byId.set(r.id, r);
	cachedRules = [...byId.values()];
	return cachedRules;
}

/** Reset per-session fire state (call on session bind). */
export function resetMusepiStreamRuleState(): void {
	sessionState = createStreamRuleState();
	cachedRules = null; // config may differ per project
}

/**
 * Compose the turn's system prompt with stream-rule injections.
 * recentText: caller-provided conversation tail for matchers.
 */
export function composeMusepiStreamPrompt(cwd: string, basePrompt: string, recentText: string): string {
	const rules = getMusepiStreamRules(cwd);
	if (rules.length === 0) return basePrompt;
	if (!sessionState) sessionState = createStreamRuleState();
	const injections = evaluateStreamRules(rules, sessionState, recentText);
	if (DEBUG && injections.length > 0) {
		console.error(`[musepi stream-rules] injected ${injections.length} rule(s) this turn`);
	}
	return applyStreamRuleInjections(basePrompt, injections);
}

/** Conversation tail for matchers: last text-ish content, capped. */
export function musepiRecentText(messages: readonly unknown[], maxChars = 4000): string {
	const parts: string[] = [];
	let total = 0;
	for (let i = messages.length - 1; i >= 0 && total < maxChars; i--) {
		const msg = messages[i] as { role?: string; content?: unknown };
		const content = msg?.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.map((c) => c as Record<string, unknown>)
				.filter((c) => c?.type === "text" || c?.type === "thinking")
				.map((c) => String(c.text ?? c.thinking ?? ""))
				.join("\n");
		}
		if (text.trim()) {
			parts.unshift(text.trim());
			total += text.length;
		}
	}
	const joined = parts.join("\n");
	return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}
