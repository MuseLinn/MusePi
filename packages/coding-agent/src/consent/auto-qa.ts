/**
 * Consent state shared between the `report_issue` tool and the UI that answers
 * its prompt.
 *
 * The handler is registered by interactive mode and consumed by the tool, so the
 * state has to live somewhere neither side owns: keeping it in the tool made
 * the renderer import the tool implementation, which is the one direction a
 * layered system must not allow.
 */
import type { Settings } from "../config/settings";

export type AutoQaConsentHandler = () => Promise<boolean | null>;

let consentHandler: AutoQaConsentHandler | null = null;
/**
 * Persistent settings instance supplied by the consent-handler registrant.
 * Subagents have in-memory `Settings` snapshots that don't write to disk;
 * we persist the decision through this disk-backed reference so a grant
 * survives across runs even when triggered from a subagent device write.
 */
let persistentConsentSettings: Settings | null = null;
/**
 * Process-global cache of the resolved consent decision. Survives across
 * subagent boundaries (subagents share this module instance), so a grant in
 * the parent applies immediately to children — including children that spawned
 * BEFORE the grant and would otherwise see a stale snapshot of
 * `dev.autoqaConsent` in their isolated `Settings`.
 *
 * `null` = never asked, never cached.
 */
let cachedConsent: boolean | null = null;
/**
 * Single-flight in-flight consent request. While the dialog is open, every
 * concurrent `report_issue` call (main + every subagent) awaits this promise
 * instead of stacking duplicate popups.
 */
let consentInFlight: Promise<boolean> | null = null;

/**
 * Register the consent handler and the persistent {@link Settings} instance
 * the decision should be written to. Passing `null` clears the handler
 * (e.g. on `InteractiveMode` teardown). Re-registration is authoritative.
 */
export function setAutoQaConsentHandler(
	handler: AutoQaConsentHandler | null,
	persistentSettings: Settings | null = null,
): void {
	consentHandler = handler;
	persistentConsentSettings = persistentSettings;
}

export function currentConsentHandler(): AutoQaConsentHandler | null {
	return consentHandler;
}

export function currentConsentSettings(): Settings | null {
	return persistentConsentSettings;
}

export function readCachedConsent(): boolean | null {
	return cachedConsent;
}

export function writeCachedConsent(value: boolean | null): void {
	cachedConsent = value;
}

export function currentConsentRequest(): Promise<boolean> | null {
	return consentInFlight;
}

export function setConsentRequest(request: Promise<boolean> | null): void {
	consentInFlight = request;
}

/** Test-only: clear consent cache + handler. Never call from production code. */
export function __resetAutoQaConsentForTests(): void {
	consentHandler = null;
	persistentConsentSettings = null;
	cachedConsent = null;
	consentInFlight = null;
}
