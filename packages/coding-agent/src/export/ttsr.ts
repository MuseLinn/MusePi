/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Monitors streaming agent output for patterns defined in rules. When a match
 * is found, the stream can be interrupted and the rule injected as a reminder.
 *
 * This implementation uses minimatch for path globs (replaces Bun.Glob) and
 * RegExp for text conditions. AstCondition patterns (ast-grep) are stored but
 * not evaluated — they require @musepi/pi-natives native bindings.
 */

import { Minimatch } from "minimatch";
import * as logger from "../utils/pi-logger.ts";

/**
 * AST matching engine interface.
 * The text-based implementation is a no-op (logs a warning on use).
 * Replace with a native ast-grep binding (@musepi/pi-natives) when available.
 */
export interface AstEngine {
	/** Match source code against ast-grep patterns. Returns true if all patterns match. */
	matchAll(patterns: string[], source: string, lang: string): Promise<boolean>;
}

// Text-based AstEngine is intentionally omitted — astCondition patterns need @musepi/pi-natives.

/** TTSR settings shape. */
export interface TtsrSettings {
	enabled?: boolean;
	contextMode?: "discard" | "rewrite";
	interruptMode?: "automatic" | "manual" | "always";
	repeatMode?: "once" | "until-satisfied";
	repeatGap?: number;
}

/** TTSR rule — same surface as OMP's Rule type. */
export interface Rule {
	name: string;
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	condition?: string | string[];
	astCondition?: string | string[];
	scope?: string | string[];
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
}

export type TtsrMatchSource = "text" | "thinking" | "tool";

export interface TtsrMatchContext {
	source: TtsrMatchSource;
	toolName?: string;
	filePaths?: string[];
	streamKey?: string;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
};

const TOOL_SCOPE_CONDITION_TOOLS = new Set(["edit", "write"]);

interface ToolScope {
	toolName?: string;
	pathPattern?: string;
	matcher?: Minimatch;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	astConditions: string[];
	scope: TtsrScope;
	globalPathMatchers?: Minimatch[];
}

interface InjectionRecord {
	lastInjectedAt: number;
}

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, string>();
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;
	#astEngine: AstEngine | undefined;

	constructor(settings?: TtsrSettings, astEngine?: AstEngine) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
		this.#astEngine = astEngine;
	}

	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (!record) return true;
		if (this.#settings.repeatMode === "once") return false;
		return this.#messageCount - record.lastInjectedAt >= this.#settings.repeatGap;
	}

	#compileConditions(rule: Rule): RegExp[] {
		const patterns = typeof rule.condition === "string" ? [rule.condition] : (rule.condition ?? []);
		return patterns
			.map((p) => {
				try {
					return new RegExp(p, "i");
				} catch (err) {
					logger.warn("TTSR: invalid condition regex", { ruleName: rule.name, pattern: p, err: String(err) });
					return null;
				}
			})
			.filter((r): r is RegExp => r !== null);
	}

	#compilePathMatchers(globs?: string[]): Minimatch[] | undefined {
		if (!globs || globs.length === 0) return undefined;
		return globs
			.map((g) => g.trim())
			.filter(Boolean)
			.map((g) => new Minimatch(g));
	}

	#buildScope(rule: Rule): TtsrScope {
		const scope: TtsrScope = { allowText: false, allowThinking: false, allowAnyTool: false, toolScopes: [] };
		const tokens = typeof rule.scope === "string" ? [rule.scope] : (rule.scope ?? ["text"]);
		for (const token of tokens) {
			const lower = token.toLowerCase().trim();
			if (lower === "text") scope.allowText = true;
			else if (lower === "thinking") scope.allowThinking = true;
			else if (lower === "tool") scope.allowAnyTool = true;
			else if (lower.startsWith("tool:") || TOOL_SCOPE_CONDITION_TOOLS.has(lower)) {
				const toolName = lower.startsWith("tool:") ? lower.slice(5) : lower;
				let pathPattern: string | undefined;
				let matcher: Minimatch | undefined;
				const parenIdx = toolName.indexOf("(");
				if (parenIdx !== -1) {
					pathPattern = toolName.slice(parenIdx + 1, toolName.lastIndexOf(")"));
					if (pathPattern) matcher = new Minimatch(pathPattern);
				}
				scope.toolScopes.push({
					toolName: parenIdx !== -1 ? toolName.slice(0, parenIdx) : toolName,
					pathPattern,
					matcher,
				});
			}
		}
		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		return `${context.source}:${context.streamKey ?? context.toolName ?? ""}`;
	}

	#matchesGlob(matcher: Minimatch | undefined, filePaths: string[] | undefined): boolean {
		if (!matcher) return true;
		if (!filePaths || filePaths.length === 0) return true;
		return filePaths.some((fp) => matcher.match(fp));
	}

	#matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (!entry.globalPathMatchers || entry.globalPathMatchers.length === 0) return true;
		if (!context.filePaths || context.filePaths.length === 0) return true;
		return entry.globalPathMatchers.some((m) => context.filePaths!.some((fp) => m.match(fp)));
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (context.source === "text" && entry.scope.allowText) return true;
		if (context.source === "thinking" && entry.scope.allowThinking) return true;
		if (context.source === "tool") {
			if (entry.scope.allowAnyTool) return true;
			for (const ts of entry.scope.toolScopes) {
				if (ts.toolName && ts.toolName !== context.toolName) continue;
				if (!this.#matchesGlob(ts.matcher, context.filePaths)) continue;
				return true;
			}
		}
		return false;
	}

	#matchesCondition(entry: TtsrEntry, buffer: string): boolean {
		return entry.conditions.some((c) => c.test(buffer));
	}

	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled) return false;
		if (this.#rules.has(rule.name)) return false;

		const conditions = this.#compileConditions(rule);
		const astConditions = (typeof rule.astCondition === "string" ? [rule.astCondition] : (rule.astCondition ?? []))
			.map((p) => p.trim())
			.filter(Boolean);
		if (astConditions.length > 0 && !this.#astEngine) {
			logger.warn(
				"TTSR: astCondition patterns require @musepi/pi-natives (native ast-grep binding). " +
					`Rule "${rule.name}" has ${astConditions.length} astCondition(s) that will not be evaluated.`,
				{
					ruleName: rule.name,
					astConditions,
				},
			);
		}
		if (conditions.length === 0 && astConditions.length === 0) return false;

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) return false;

		this.#rules.set(rule.name, {
			rule,
			conditions,
			astConditions,
			scope,
			globalPathMatchers: this.#compilePathMatchers(rule.globs),
		});
		if (scope.allowText) this.#canMatchText = true;
		if (scope.allowThinking) this.#canMatchThinking = true;
		return true;
	}

	checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
		if (context.source === "text" && !this.#canMatchText) return [];
		if (context.source === "thinking" && !this.#canMatchThinking) return [];

		const key = this.#bufferKey(context);
		const buf = (this.#buffers.get(key) ?? "") + delta;
		this.#buffers.set(key, buf);
		return this.#matchBuffer(buf, context);
	}

	checkSnapshot(snapshot: string, context: TtsrMatchContext): Rule[] {
		const key = this.#bufferKey(context);
		this.#buffers.set(key, snapshot);
		return this.#matchBuffer(snapshot, context);
	}

	async checkAstSnapshot(_snapshot: string, _context: TtsrMatchContext): Promise<Rule[]> {
		// AstCondition requires @musepi/pi-natives (ast-grep). Not available.
		return [];
	}

	hasAstRules(): boolean {
		for (const entry of this.#rules.values()) {
			if (entry.astConditions.length > 0) return true;
		}
		return false;
	}

	#matchBuffer(buffer: string, context: TtsrMatchContext): Rule[] {
		const matched: Rule[] = [];
		for (const entry of this.#rules.values()) {
			if (!this.#canTrigger(entry.rule.name)) continue;
			if (!this.#matchesGlobalPaths(entry, context)) continue;
			if (!this.#matchesScope(entry, context)) continue;
			if (!this.#matchesCondition(entry, buffer)) continue;
			matched.push(entry.rule);
		}
		return matched;
	}

	markInjected(rulesToMark: Rule[]): void {
		for (const rule of rulesToMark) {
			this.#injectionRecords.set(rule.name, { lastInjectedAt: this.#messageCount });
		}
	}

	markInjectedByNames(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: this.#messageCount });
		}
	}

	getInjectedRuleNames(): string[] {
		return [...this.#injectionRecords.keys()];
	}

	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: this.#messageCount });
		}
	}

	resetBuffer(): void {
		this.#buffers.clear();
	}

	hasRules(): boolean {
		return this.#rules.size > 0;
	}

	getRules(): Rule[] {
		return [...this.#rules.values()].map((e) => e.rule);
	}

	incrementMessageCount(): void {
		this.#messageCount++;
	}

	getMessageCount(): number {
		return this.#messageCount;
	}

	getSettings(): Required<TtsrSettings> {
		return { ...this.#settings };
	}
}
