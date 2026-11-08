import { logger } from "@musepi/pi-utils";
import type { Settings } from "../config/settings";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import { findMemoryBackendProvider } from "./providers";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory
 *   - `memory.backend === "mnemopi"`  → local Mnemopi SQLite memory
 *   - `memory.backend === "local"`      → local rollout summary pipeline
 *   - everything else                   → no-op
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = settings.get("memory.backend");
	const provider = findMemoryBackendProvider(id);
	if (provider) {
		try {
			return await provider.create(settings);
		} catch (error) {
			logger.warn("Memory backend provider failed; falling back to the built-in backend", {
				backend: id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (id === "hindsight") return (await import("../hindsight/backend")).hindsightBackend;
	if (id === "mnemopi") return (await import("../mnemopi/backend")).mnemopiBackend;
	if (id === "sharpshooter") return (await import("../sharpshooter/backend")).sharpshooterBackend;
	if (id === "local") return localBackend;
	return offBackend;
}
