/**
 * A calm "still working" signal for slow RPCs.
 *
 * A request that outruns the caller's patience must NOT reject: the daemon is
 * often genuinely working (session.create loads the extension set, a model turn
 * sits in provider prep), and a hard timeout turned every slow-but-healthy call
 * into a red "请求失败" banner that a retry immediately fixed. The caller read
 * a spurious failure.
 *
 * So the ceiling is generous (see `REQUEST_TIMEOUT_MS`) and, past this delay,
 * the request starts REPORTING that it is still waiting: a tick every second
 * carrying the elapsed time, which a caller can render as "正在加载… 3s" instead
 * of a frozen screen. The request itself still resolves or rejects on its own.
 *
 * The tick is a real interval, not a rAF loop: it must keep firing while the
 * renderer is busy, and it is cleared the moment the request settles.
 */

/** Wait this long before the first "still waiting" tick. */
export const RPC_SLOW_HINT_AFTER_MS = 2_500;

/** Cadence of the elapsed-time ticks once a request is "slow". */
export const RPC_SLOW_HINT_INTERVAL_MS = 1_000;

/** One progress tick for a slow RPC. */
export interface RpcProgressTick {
	/** Milliseconds since the request was sent. */
	elapsedMs: number;
}

/**
 * Attach a slow-hint ticker to a promise.
 *
 * `onTick` fires at {@link RPC_SLOW_HINT_AFTER_MS} and then every
 * {@link RPC_SLOW_HINT_INTERVAL_MS} until `promise` settles. It never fires
 * for a fast request, and it never changes the request's outcome — the
 * returned promise resolves/rejects exactly as `promise` does.
 *
 * The ticker is `.unref()`-ed so a pending request cannot hold the process
 * open (Electron renderer or daemon CLI alike).
 */
export function withSlowHint<T>(promise: Promise<T>, onTick: (tick: RpcProgressTick) => void): Promise<T> {
	const startedAt = Date.now();
	let timer: ReturnType<typeof setInterval> | null = null;
	const stop = (): void => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
	const arm = setTimeout(() => {
		timer = setInterval(() => {
			onTick({ elapsedMs: Date.now() - startedAt });
		}, RPC_SLOW_HINT_INTERVAL_MS);
		timer.unref?.();
		onTick({ elapsedMs: Date.now() - startedAt });
	}, RPC_SLOW_HINT_AFTER_MS);
	arm.unref?.();
	return promise.then(
		value => {
			clearTimeout(arm);
			stop();
			return value;
		},
		error => {
			clearTimeout(arm);
			stop();
			throw error;
		},
	);
}

/** Seconds, rounded for display: "3s" reads better than "3127ms". */
export function elapsedSeconds(elapsedMs: number): number {
	return Math.max(1, Math.round(elapsedMs / 1000));
}
