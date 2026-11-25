import { logger } from "@musepi/pi-utils";
import type { Settings } from "../config/settings";
import { musememBackend } from "./musemem-backend";
import { offBackend } from "./off-backend";
import { findMemoryBackendProvider } from "./providers";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - a registered provider for the id wins (`registerMemoryBackendProvider`);
 *   - otherwise the built-in implementation for that id;
 *   - anything unknown is the no-op backend.
 *
 * Every built-in backend also ships as a host-scope package
 * (`memory-off` / `memory-musemem` / `memory-hindsight` / `memory-mnemopi` /
 * `memory-sharpshooter`), so a mounted host resolves through the provider seam
 * and the branches below are the fallback for hosts that mount nothing.
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
	// `local` is the pre-rename id. Config files migrate it before this runs;
	// programmatic overrides can still reach the same backend through it.
	if (id === "musemem" || (id as string) === "local") return musememBackend;
	return offBackend;
}
