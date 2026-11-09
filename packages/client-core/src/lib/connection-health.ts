/**
 * Connection liveness for the mobile shell (bitfun `useConnectionHealth`
 * parity).
 *
 * A WebSocket only reports the drops it can see. On a phone the underlying TCP
 * can go silent — Wi-Fi → cellular handoff, NAT table expiry, Doze freezing the
 * socket — and no `close` event ever fires: the header keeps claiming "live"
 * while every frame disappears, and the next prompt lands in a dead socket with
 * the composer stuck on "sending".
 *
 * The protocol has no heartbeat frame, so liveness is probed with an ordinary
 * RPC. Any reply proves the link in both directions — a success and a host-side
 * error (an older host without `ping`) both count — while a timeout proves
 * neither. Two consecutive timeouts force a fresh connection, which re-runs the
 * hello/welcome handshake and republishes the whole snapshot.
 *
 * The probe also runs on foreground return: a WebView suspended for a while
 * resumes with whatever the OS left of the socket, and this is the only cheap
 * way to find out whether "whatever" is still a connection.
 */

import { useEffect, useRef } from "react";
import type { SessionClient } from "./client";

/** Steady-state probe cadence while the app is visible. */
const PING_INTERVAL_MS = 15_000;
/** A probe that has not answered by now is treated as a miss. */
const PING_TIMEOUT_MS = 5_000;
/** Second probe after a miss — absorbs one lost frame before reconnecting. */
const RETRY_DELAY_MS = 1_200;

/**
 * One liveness probe. Resolves `true` when the host answered in any form and
 * `false` when nothing came back before the deadline.
 */
export function probeConnection(client: SessionClient, timeoutMs = PING_TIMEOUT_MS): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		let settled = false;
		const finish = (alive: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(alive);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		// `rpc` has no built-in deadline on the collab transport; the timer
		// above is the deadline. The inner cap only keeps the pending map from
		// holding the entry forever after we stopped waiting.
		client.rpc("ping", undefined, { timeoutMs: timeoutMs + 1_000 }).then(
			() => finish(true),
			// An error reply still arrived over the wire — the link is alive.
			() => finish(true),
		);
	});
}

/** Phases where a silent link is a bug. "connecting"/"waiting" are handshakes —
 *  the welcome and snapshot timers own those, and probing them would fight a
 *  slow-but-alive host. "ended" has its own recovery banner. */
function shouldProbe(phase: string): boolean {
	return phase === "live" || phase === "reconnecting" || phase === "workspace";
}

/**
 * Keep `client` honest while the app is visible, and re-verify it on every
 * foreground return. `onUnreachable` is expected to rebuild the connection
 * (the app replaces the client and re-runs the handshake).
 */
export function useConnectionHealth(client: SessionClient | null, onUnreachable: () => void): void {
	const recoverRef = useRef(onUnreachable);
	recoverRef.current = onUnreachable;

	useEffect(() => {
		if (!client) return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let misses = 0;

		const clear = (): void => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		};

		const schedule = (delay: number): void => {
			clear();
			if (disposed) return;
			timer = setTimeout(() => void tick(), delay);
		};

		const tick = async (): Promise<void> => {
			if (disposed) return;
			// Background probes are wasted work: the platform may freeze the
			// page mid-flight and the socket usually dies only in suspension.
			// The foreground listener re-probes as soon as we come back.
			if (document.hidden) {
				schedule(PING_INTERVAL_MS);
				return;
			}
			const phase = client.getSnapshot().phase;
			if (!shouldProbe(phase)) {
				schedule(PING_INTERVAL_MS);
				return;
			}
			const alive = await probeConnection(client);
			if (disposed) return;
			if (alive) {
				misses = 0;
				schedule(PING_INTERVAL_MS);
				return;
			}
			misses += 1;
			if (misses === 1) {
				schedule(RETRY_DELAY_MS);
				return;
			}
			misses = 0;
			recoverRef.current();
			// The reconnect replaces the client, which re-runs this effect. The
			// timer below only covers a caller that keeps the same instance.
			schedule(PING_INTERVAL_MS);
		};

		const onVisible = (): void => {
			if (document.hidden || disposed) return;
			if (!shouldProbe(client.getSnapshot().phase)) return;
			// Foreground return skips the remaining interval — a suspended page
			// may hold a socket the OS already tore down.
			void tick();
		};

		schedule(PING_INTERVAL_MS);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			disposed = true;
			clear();
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [client]);
}
