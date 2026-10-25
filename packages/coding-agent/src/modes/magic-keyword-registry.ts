/**
 * Extension-contributed magic keywords — the registry a session reads.
 *
 * A magic keyword is a standalone word typed in the composer that, on submit,
 * appends a hidden notice nudging the model. The three first-party keywords
 * arrive through the bundled magic-keywords package; other extensions use
 * `pi.registerMagicKeyword` on the same terms.
 *
 * Lifecycle mirrors the design-system registry (M3 §3): registrations are queued
 * during extension loading and replayed into this registry during session
 * initialization. Unload drops a contributor's keywords, so a disabled extension
 * stops contributing — a keyword must not outlive the extension that declared it.
 *
 * The registry is process-level and session-independent by design: several
 * sessions read the same contributions, and an extension reloaded mid-life must
 * be visible to all of them without a restart.
 *
 * @module modes/magic-keyword-registry
 */

import type { ExtensionMagicKeyword, RegisteredMagicKeyword } from "../extensibility/extensions/types";
import { createGradientHighlighter, type KeywordHighlighter } from "./gradient-highlight";
import { magicKeywordRegex } from "./magic-keyword-boundary";
import { keywordInProse } from "./markdown-prose";

/** Live contributions, keyed by keyword name — one per name, last registration wins. */
const keywords = new Map<string, RegisteredMagicKeyword>();

/**
 * Highlighters compiled per contribution.
 *
 * Kept beside the keywords and rebuilt on registration so a keyword that
 * declares a gradient gets the same editor treatment the built-ins have.
 */
const highlighters = new Map<string, KeywordHighlighter>();

/** Default stop count, matching what the built-in keywords use. */
const DEFAULT_STOPS = 14;

/** Escape a literal so it can be used inside a RegExp safely. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a contribution's highlighter, or undefined when it declares none. */
function buildHighlighter(keyword: RegisteredMagicKeyword): KeywordHighlighter | undefined {
	const spec = keyword.highlight;
	if (!spec) return undefined;
	const stops = spec.stops ?? DEFAULT_STOPS;
	// The trigger word is what gets painted, not the identity (`workflow`
	// triggers on "workflowz" and must paint "workflowz"). A literal probe and a
	// boundary-aware paint: the word must never reach a RegExp unescaped, or a
	// word containing regex metacharacters would match far more than itself.
	const trigger = escapeRegExp(keyword.trigger ?? keyword.name);
	return createGradientHighlighter({
		probe: new RegExp(trigger),
		highlight: magicKeywordRegex(keyword.trigger ?? keyword.name, "g"),
		stops,
		hue: t => spec.from + t * (spec.to - spec.from),
	});
}

/** Register (or replace) one contribution. */
export function registerMagicKeyword(keyword: RegisteredMagicKeyword): void {
	keywords.set(keyword.name, keyword);
	// Rebuilt on every registration: a replace must not keep the old palette.
	const highlighter = buildHighlighter(keyword);
	if (highlighter) highlighters.set(keyword.name, highlighter);
	else highlighters.delete(keyword.name);
}

/** Drop one contributor's keywords by name, or all of one extension's by sourceId. */
export function unregisterMagicKeyword(name?: string, sourceId?: string): void {
	if (name !== undefined) {
		keywords.delete(name);
		highlighters.delete(name);
		return;
	}
	if (sourceId === undefined) return;
	for (const [key, entry] of [...keywords]) {
		if (entry.sourceId === sourceId) {
			keywords.delete(key);
			highlighters.delete(key);
		}
	}
}

/** Read-only view for a session building notices. */
export function listMagicKeywords(): readonly RegisteredMagicKeyword[] {
	return [...keywords.values()];
}

/** Test/host helper: drop every contribution. */
export function resetMagicKeywordRegistry(): void {
	keywords.clear();
	highlighters.clear();
}

/**
 * Drain queued registrations into the live registry.
 *
 * Called where the other pending registrations are replayed, so every extension
 * contribution reaches the registry through one lifecycle rather than two.
 */
export function applyPendingMagicKeywords(pending: readonly RegisteredMagicKeyword[]): void {
	for (const entry of pending) registerMagicKeyword(entry);
}

/**
 * Whether `text` mentions the keyword in prose (never inside a code block,
 * inline span, or XML/HTML section).
 *
 * Built from the same boundary helper the compiled-in keywords use, so an
 * extension's keyword cannot match inside `plan.ts` or `Planning` any more than
 * `ultrathink` can.
 */
export function containsMagicKeyword(keyword: ExtensionMagicKeyword, text: string): boolean {
	// The trigger word is what prose-matches, not the identity (see the type).
	return keywordInProse(text, magicKeywordRegex(keyword.trigger ?? keyword.name));
}

/**
 * Every contribution's highlighter, in registration order.
 *
 * The editor chains these over the text after the built-ins, so an extension's
 * keyword is painted on the same pass — a word that nudges the model should
 * look like it does, the same as `ultrathink` does.
 */
export function listMagicKeywordHighlighters(): readonly KeywordHighlighter[] {
	return [...highlighters.values()];
}
