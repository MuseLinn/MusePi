/**
 * Whether an extension may be loaded, given a condition attached to it.
 *
 * A plugin can declare a condition in its manifest. When the condition holds,
 * the plugin loads; when it does not, it is skipped — not errored, and not
 * loaded and then discovered to be wrong. The condition is evaluated on every
 * load, so a plugin gated on the active profile or on a setting follows it
 * across restarts without its manifest changing.
 *
 * Conditions are named, not expressions. A manifest is user-editable data, and
 * an expression there means the file can execute arbitrary code during load. A
 * named predicate is enumerable, completable, and testable; a manifest naming
 * one that does not exist is reported rather than silently ignored, and a
 * plugin whose condition cannot be decided is not loaded, because the gate
 * exists to keep things out and a failed check is not evidence of safety.
 *
 * @module extensibility/enablement
 */

import { logger } from "@musepi/pi-utils";
import { getActiveProfile } from "@musepi/pi-utils/dirs";
import { Settings } from "../config/settings";

/** A predicate deciding whether something is currently active. */
export type EnablementPredicate = () => boolean;

/**
 * Named conditions that take no argument.
 *
 * A predicate that reads a setting treats an unreadable value as "not set"
 * rather than throwing: settings are readable only after the configuration
 * layer is up, and a gate has to answer during early boot. The two failure
 * directions are deliberate per predicate — a gate reads false, because the
 * thing it guards should stay out; the settings panel reads its own way
 * because a setting that should be visible must stay reachable to turn the
 * thing back on.
 */
const UNARY_CONDITIONS: Readonly<Record<string, EnablementPredicate>> = {
	/** Speech input is configured and enabled. */
	sttEnabled: () => readSetting("stt.enabled") === true,
	/** Speech output is configured and enabled. */
	speechEnabled: () => readSetting("speech.enabled") === true,
	/** The browser subsystem's own switch is on. */
	browserEnabled: () => readSetting("browser.enabled") === true,
	/** Computer use's own switch is on. Note its schema default is already false,
	 *  so an absent value means off here as elsewhere. */
	computerEnabled: () => readSetting("computer.enabled") === true,
	/** Language servers are enabled. */
	lspEnabled: () => readSetting("lsp.enabled") === true,
	/** Running under a desktop shell rather than headless. */
	desktopShell: () => readSetting("shell.enabled") === true,
	/** Running on macOS. */
	macOS: () => process.platform === "darwin",
};

function readSetting(path: string): unknown {
	try {
		return Settings.instance.get(path as Parameters<Settings["get"]>[0]);
	} catch {
		return undefined;
	}
}

/** The condition this name and argument resolve to, or undefined if unknown. */
function resolvePredicate(condition: string, argument?: string): EnablementPredicate | undefined {
	if (condition === "profileIs") {
		if (argument === undefined) return undefined;
		// `getActiveProfile` reads the profile this process actually runs under,
		// which is what a gate has to compare against. It is not cached here:
		// the profile can be selected later in a process that stays alive.
		return () => getActiveProfile() === argument;
	}
	return UNARY_CONDITIONS[condition];
}

/**
 * Whether a plugin's condition holds.
 *
 * @param condition - the condition name from the manifest, if any.
 * @param argument - the argument, for the forms that take one
 * (`when: { profileIs: desktop }`).
 * @returns `true` when the plugin may load. A plugin with no condition always
 * may, and so does one naming a condition that is not registered — gating a
 * plugin off over a name this build does not know would disable something
 * rather than protect it.
 */
export function enablementHolds(condition: string | undefined, argument?: string): boolean {
	if (condition === undefined) return true;
	const predicate = resolvePredicate(condition, argument);
	if (predicate === undefined) {
		logger.warn("enablement: condition not registered, loading unconditionally", { condition, argument });
		return true;
	}
	try {
		return predicate();
	} catch (err) {
		logger.warn("enablement: condition threw, treating as not met", { condition, argument, err });
		return false;
	}
}

/** Every condition name a manifest may use, for validation and completion. */
export function knownEnablementConditions(): readonly string[] {
	return [...Object.keys(UNARY_CONDITIONS), "profileIs"];
}

/** Whether a condition name with this argument resolves to a predicate. */
export function isKnownEnablementCondition(condition: string, argument?: string): boolean {
	return resolvePredicate(condition, argument) !== undefined;
}
