/**
 * SessionProjectionService — the read-model seam as an L2 daemon service.
 *
 * Seam:
 * - Input: domain units registered by whoever owns them
 *   (`register(definition)`), and committed wire events (`applyEvent`).
 * - Output: `snapshot(sessionId)` baselines and per-event change lists, which
 *   the session host turns into `kind:"projection"` frames.
 * - Lifecycle: holds every session's fold state. `start` seeds nothing (a
 *   session is seeded when it is adopted); `stop` drops the state, so a
 *   remount starts clean.
 *
 * The registry is a **service**
 * that owns driving and storage, and each domain contributes a pure unit from
 * its own service — there is no central list of domains anywhere. Adding a
 * domain therefore means writing its unit next to the domain and registering
 * it there; this service never names another domain.
 *
 * Registration is reversible on purpose: a `DaemonService.stop` is the L2
 * equivalent of a cordis effect, so a unit registered by a service is withdrawn
 * when that service stops.
 */

import type { SessionProjectionChange, SessionProjectionSnapshot } from "@musepi/pi-wire";
import type {
	ProjectionDefinition,
	ProjectionEvent,
	ProjectionHandle,
	ProjectionSeed,
	SessionProjectionRegistry,
} from "../../session/session-projections";
import type { DaemonService } from "./types";

declare module "@deepseek-ai/cordis" {
	interface Context {
		/** The projection registry service. */
		sessionProjections: SessionProjectionService;
	}
}

export class SessionProjectionService implements DaemonService {
	readonly key = "sessionProjections";

	/** The host owns the storage (its commit path and snapshot builders read
	 *  it directly); this service is the registration and read surface over
	 *  that same instance, so there is never a second copy of a session's
	 *  fold state. */
	readonly #registry: SessionProjectionRegistry;

	constructor(registry: SessionProjectionRegistry) {
		this.#registry = registry;
	}

	/** Register one domain unit. The returned handle both reads that domain's
	 *  per-session state (so a domain never keeps a second copy) and withdraws
	 *  the unit, which is what lets a domain service own its registration across
	 *  a stop/start. */
	register<S>(definition: ProjectionDefinition<S>): ProjectionHandle<S> {
		return this.#registry.register(definition);
	}

	seed(sessionId: string, seed: ProjectionSeed): void {
		this.#registry.seed(sessionId, seed);
	}

	seedIfAbsent(sessionId: string, seed: ProjectionSeed): void {
		this.#registry.seedIfAbsent(sessionId, seed);
	}

	snapshot(sessionId: string): SessionProjectionSnapshot | undefined {
		return this.#registry.snapshot(sessionId);
	}

	applyEvent(sessionId: string, event: ProjectionEvent): SessionProjectionChange[] {
		return this.#registry.applyEvent(sessionId, event);
	}

	clear(sessionId: string): void {
		this.#registry.clear(sessionId);
	}

	/** The units currently contributing, for diagnostics and tests. */
	keys(): string[] {
		return this.#registry.keys();
	}

	stop(): void {
		this.#registry.clearAll();
	}
}
