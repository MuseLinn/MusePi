import type { Settings } from "../config/settings";

/** Settings accessors for the sharpshooter backend, read from the shared Settings store. */
export const cfgSharpshooterModel = {
	get: (settings: Settings) => settings.get("sharpshooter.model"),
};

export const cfgSharpshooterMinPromptLength = {
	get: (settings: Settings) => settings.get("sharpshooter.minPromptLength"),
	default: 16,
};

export const cfgSharpshooterIntervalMinutes = {
	get: (settings: Settings) => settings.get("sharpshooter.intervalMinutes"),
	default: 5,
};

export const cfgSharpshooterInjectionTokenLimit = {
	get: (settings: Settings) => settings.get("sharpshooter.injectionTokenLimit"),
	default: 15000,
};
