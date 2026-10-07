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
 * The settings keys a subsystem keeps behind its own on/off switch.
 *
 * Named here so the loader's gate and the settings panel read the same list.
 * `shell.enabled` is deliberately absent from the schema and so from the type
 * the settings surface is built from — it is written through the extension
 * service only — which is why this is its own type rather than a derived one.
 */
export type SubsystemSwitchKey =
	| "stt.enabled"
	| "speech.enabled"
	| "browser.enabled"
	| "computer.enabled"
	| "lsp.enabled"
	| "shell.enabled";

/**
 * Whether a subsystem's own switch reads as on.
 *
 * Two consumers ask this question and they do not agree on what an unreadable
 * answer means. A gate treats it as off, because the thing it guards should stay
 * out. The settings panel treats it as on for most subsystems, because a setting
 * hidden by a failed read cannot be turned back on. That difference is real and
 * lives with the consumer, not here.
 *
 * What is shared is which key answers which question and how a missing key
 * differs from a key set to false — `shell.enabled` has no schema entry and so
 * no default, which makes it on unless something explicitly wrote false, while
 * `stt.enabled` defaults to false and so an absent value is off. Two registries
 * reading these independently is how a subsystem ends up gated in the loader
 * and visible in the panel.
 *
 * @param key - the subsystem switch's settings key.
 * @returns whether the switch is on, or `undefined` when it cannot be read.
 * A key that reads normally never yields `undefined` — an unset key resolves to
 * its schema default.
 */
export function readSubsystemEnabled(key: SubsystemSwitchKey): boolean | undefined {
	const raw = readRawSubsystemSwitch(key);
	// `undefined` here means the read failed, and it has to stay distinguishable
	// from a switch that genuinely reads false — comparing it to `true` here
	// would collapse the two and leave every caller with no way to apply its own
	// failure direction.
	if (raw === undefined) return undefined;
	return raw === true;
}

/** A gate's answer when a switch cannot be read: keep the thing out. */
const READ_FAILURE_AS_GATE = false;

/** The settings panel's answer when a switch cannot be read: keep the setting
 *  reachable, because a setting hidden by a failed read cannot be turned back on. */
const READ_FAILURE_AS_VISIBILITY = true;

/**
 * Named conditions that take no argument.
 *
 * Each delegates to {@link readSubsystemEnabled} and then applies its own
 * direction, so a gate that cannot read the switch keeps the plugin out.
 */
const UNARY_CONDITIONS: Readonly<Record<string, EnablementPredicate>> = {
	/** Speech input is configured and enabled. */
	sttEnabled: () => readSubsystemEnabled("stt.enabled") ?? READ_FAILURE_AS_GATE,
	/** Speech output is configured and enabled. */
	speechEnabled: () => readSubsystemEnabled("speech.enabled") ?? READ_FAILURE_AS_GATE,
	/** The browser subsystem's own switch is on. */
	browserEnabled: () => readSubsystemEnabled("browser.enabled") ?? READ_FAILURE_AS_GATE,
	/** Computer use's own switch is on. */
	computerEnabled: () => readSubsystemEnabled("computer.enabled") ?? READ_FAILURE_AS_GATE,
	/** Language servers are enabled. */
	lspEnabled: () => readSubsystemEnabled("lsp.enabled") ?? READ_FAILURE_AS_GATE,
	/** Running under the desktop shell rather than headless.
	 *  This key is absent from the settings schema, so `readSubsystemEnabled`
	 *  cannot answer it — there is no default to resolve an absent value to —
	 *  and only an explicit `false` means the shell is off, which is the reading
	 *  the daemon's registry projection uses. */
	desktopShell: () => readRawSubsystemSwitch("shell.enabled") !== false,
	/** Running on macOS. */
	macOS: () => process.platform === "darwin",
};

/**
 * Read a switch that has no schema entry.
 *
 * `Settings.get` is typed against the schema, and `shell.enabled` is not in it —
 * but the type is not the only problem: `get` resolves the value through the
 * schema's path-segment table, which has no entry for this key, so a value
 * written through the extension service never reads back through it. `getRaw`
 * addresses the merged store directly and is the same channel the extension
 * service writes the key through.
 *
 * @param key - the switch's settings key.
 * @returns the raw value, or `undefined` when it cannot be read.
 */
export function readRawSubsystemSwitch(key: SubsystemSwitchKey): unknown {
	try {
		return Settings.instance.getRaw(key);
	} catch {
		return undefined;
	}
}

/**
 * Whether a subsystem's switch reads as on, for a consumer that keeps its
 * settings reachable when the switch cannot be read.
 *
 * @param key - the subsystem switch's settings key.
 * @returns whether the panel should show the settings this switch governs.
 */
export function subsystemVisible(key: SubsystemSwitchKey): boolean {
	return readSubsystemEnabled(key) ?? READ_FAILURE_AS_VISIBILITY;
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
