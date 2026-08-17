/**
 * Per-connection event coalescing for the daemon transports.
 *
 * The daemon pushes subscription envelopes (`{ kind, seq, payload }`) from
 * live sessions, journal catch-up, terminal output and provider progress.
 * A busy turn emits hundreds of small envelopes; sending each as its own
 * frame both floods the socket and thrashes the GUI's React store. This
 * batcher coalesces events pushed within a short window into ONE `batch`
 * frame (`{ kind: "batch", events: [...] }` — inner envelopes keep their own
 * seq, so order and cursor semantics are unchanged), and defers flushes
 * while the transport's write buffer is above a threshold (backpressure:
 * the GUI is consuming slower than we produce). Deferral is bounded — a
 * flush is forced after maxDeferMs so latency never grows unbounded.
 *
 * RPC responses (JSON-RPC result/error) NEVER ride the batch: callers send
 * them directly on the connection, so interactive requests stay ahead of
 * the event flood (priority by construction, not by queue buckets).
 *
 * Pure transport logic — no daemon imports, no I/O, unit-testable.
 */

/** One subscription envelope; `sessionId` optional (B1: multi-session). */
export interface BatchedEvent {
	kind: string;
	seq?: number;
	payload?: unknown;
	sessionId?: string;
	[key: string]: unknown;
}

export interface EventBatcherOptions {
	/** Flush window: events pushed within this window coalesce into one frame. */
	windowMs?: number;
	/** Max events per batch frame (upper bound on frame size). */
	maxEvents?: number;
	/** Socket write buffer above which flush defers (backpressure). */
	backpressureBytes?: number;
	/** Max time a flush can be deferred by backpressure before forcing. */
	maxDeferMs?: number;
	/** Backpressure probe: current bytes buffered on the transport. */
	buffered?: () => number;
}

const DEFAULT_WINDOW_MS = 8;
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_BACKPRESSURE_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEFER_MS = 64;

export class EventBatcher {
	readonly #send: (message: unknown) => void;
	readonly #opts: Required<EventBatcherOptions>;
	#queue: BatchedEvent[] = [];
	#timer: Timer | null = null;
	#deferDeadline = 0;

	constructor(send: (message: unknown) => void, options: EventBatcherOptions = {}) {
		this.#send = send;
		this.#opts = {
			windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
			maxEvents: options.maxEvents ?? DEFAULT_MAX_EVENTS,
			backpressureBytes: options.backpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES,
			maxDeferMs: options.maxDeferMs ?? DEFAULT_MAX_DEFER_MS,
			buffered: options.buffered ?? (() => 0),
		};
	}

	/** Enqueue one envelope; coalesced with events pushed before the flush. */
	push(event: BatchedEvent): void {
		this.#queue.push(event);
		if (this.#queue.length >= this.#opts.maxEvents) {
			// Burst exceeded the frame bound — drain immediately rather than
			// let the queue grow without limit.
			this.flushNow();
			return;
		}
		if (this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#flush();
		}, this.#opts.windowMs);
	}

	/**
	 * Force an immediate send of everything queued (bounded by maxEvents
	 * chunks). Used by journal replay so a catch-up page lands as one frame
	 * and the event loop yields between pages.
	 */
	flushNow(): void {
		this.#clearTimer();
		this.#flush();
	}

	/** True when events are queued (for replay pacing / teardown). */
	get hasPending(): boolean {
		return this.#queue.length > 0;
	}

	#clearTimer(): void {
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	#flush(): void {
		if (this.#queue.length === 0) return;
		const buffered = this.#opts.buffered();
		if (buffered > this.#opts.backpressureBytes) {
			// Socket backed up: arm a bounded defer deadline on first sight,
			// then hold the batch and retry within the window. Latency stays
			// bounded by maxDeferMs even under sustained consumer stall.
			if (this.#deferDeadline === 0) this.#deferDeadline = Date.now() + this.#opts.maxDeferMs;
			if (Date.now() < this.#deferDeadline) {
				if (!this.#timer) {
					this.#timer = setTimeout(() => {
						this.#timer = null;
						this.#flush();
					}, this.#opts.windowMs);
				}
				return;
			}
		}
		this.#deferDeadline = 0;
		const events = this.#queue;
		this.#queue = [];
		if (events.length === 1) {
			this.#send(events[0] as BatchedEvent);
			return;
		}
		// Coalesced frame: inner envelopes keep their own seq.
		this.#send({ kind: "batch", events });
	}
}
