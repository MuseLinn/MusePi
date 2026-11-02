/** Process-local voice provider registry shared by the daemon and separately
 * bundled component modules. Before components mount, the static catalog stays
 * available for CLI and worker paths. Disposal withdraws only the registration
 * made by that fiber. */

const STT_ENGINE_IDS = ["whisper", "sensevoice", "parakeet"] as const;
const TTS_ENGINE_IDS = ["kokoro", "melotts-zh"] as const;
const DEFAULT_REGISTRATION = Symbol("default-voice-registration");
const ACTIVATION_STATE_KEY = Symbol.for("musepi.voice-engine-activations");

interface VoiceActivationState {
	stt?: Map<string, symbol>;
	tts?: Map<string, symbol>;
}

const globalScope = globalThis as typeof globalThis & { [key: symbol]: unknown };
const activationState = (globalScope[ACTIVATION_STATE_KEY] ?? {}) as VoiceActivationState;
globalScope[ACTIVATION_STATE_KEY] = activationState;

function activate(
	registry: Map<string, symbol> | undefined,
	id: string,
): { registry: Map<string, symbol>; cleanup: () => void } {
	const target = registry ?? new Map<string, symbol>();
	const token = Symbol(id);
	target.set(id, token);
	return {
		registry: target,
		cleanup: () => {
			if (target.get(id) === token) target.delete(id);
		},
	};
}

export function activateSttEngine(id: string): () => void {
	if (!activationState.stt) {
		activationState.stt = new Map(STT_ENGINE_IDS.map(key => [key, DEFAULT_REGISTRATION]));
	}
	const activation = activate(activationState.stt, id);
	activationState.stt = activation.registry;
	return activation.cleanup;
}

export function activateTtsEngine(id: string): () => void {
	if (!activationState.tts) {
		activationState.tts = new Map(TTS_ENGINE_IDS.map(key => [key, DEFAULT_REGISTRATION]));
	}
	const activation = activate(activationState.tts, id);
	activationState.tts = activation.registry;
	return activation.cleanup;
}

export function isSttEngineActive(id: string): boolean {
	return activationState.stt?.has(id) ?? true;
}

export function isTtsEngineActive(id: string): boolean {
	return activationState.tts?.has(id) ?? true;
}

/** Restore the pre-component catalog after an isolated runtime is disposed. */
export function resetVoiceEngineActivations(): void {
	activationState.stt = undefined;
	activationState.tts = undefined;
}
