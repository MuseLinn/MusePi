/**
 * Seat declarations and waiting contributions.
 *
 * A seat has two independent facts: it exists (declared in `extension-slots.ts`),
 * and some mounted component currently renders it. `assertKnownComponentSlot`
 * answers the first; this module answers the second, which is what a plugin can
 * observe.
 *
 * The model is the parent-owned slot: the component that renders a seat declares
 * it, so the seat is live exactly while that component is registered. A
 * contributor targeting a seat therefore waits — its registration runs when the
 * declaration appears, is removed when the declaration goes away, and runs again
 * if the owner comes back. Without that, a contribution outlives the surface it
 * was written for and reappears when something else declares the name.
 *
 * Root seats (`main.conversation`, `shell.overlay`, `settings.section`, …) are
 * always live because the app shell renders them for the process lifetime; they
 * are declared once at startup so a contributor registers immediately instead of
 * waiting forever.
 *
 * One live owner per seat. Two components declaring one seat is a composition
 * error rather than last-writer-wins, because the loser would keep rendering a
 * seat it does not own.
 *
 * Every contribution is a *rider*: a `register` callback plus the disposer it
 * returns. A rider is either riding (its disposer is live) or queued. The only
 * transitions are: the seat becomes live → queued riders start riding; the seat
 * collapses → riding riders are disposed and queued again; a rider is stopped →
 * it leaves both sets for good.
 */

/** State a rider keeps across seat lifetimes. */
interface Rider {
	/** Start riding. Called once per seat lifetime. */
	register: () => () => void;
	/** Disposer of the current ride, when riding. */
	dispose: (() => void) | undefined;
	/** False once `injectSeat`'s outer disposer ran. */
	live: boolean;
}

interface SeatEntry {
	/** Declaring component; `null` for a core seat; `undefined` while only riders hold the entry. */
	ownerId?: string | null;
	/** Riders currently rendering. */
	riding: Set<Rider>;
	/** Riders waiting for this seat to be declared. */
	queued: Set<Rider>;
}

const seats = new Map<string, SeatEntry>();
const listeners = new Set<(slot: string) => void>();

function entryFor(slot: string): SeatEntry {
	let entry = seats.get(slot);
	if (!entry) {
		entry = { riding: new Set(), queued: new Set() };
		seats.set(slot, entry);
	}
	return entry;
}

function notify(slot: string): void {
	for (const listener of listeners) listener(slot);
}

/** Whether a component (or the shell) currently renders `slot`. */
export function isSeatDeclared(slot: string): boolean {
	const entry = seats.get(slot);
	return entry !== undefined && entry.ownerId !== undefined;
}

/** The component that declared `slot`; `null` for a core seat; undefined when nothing has. */
export function seatOwnerOf(slot: string): string | null | undefined {
	return seats.get(slot)?.ownerId;
}

/** Watch seat liveness. Returns a disposer. */
export function onSeatChange(listener: (slot: string) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function startRider(rider: Rider): void {
	if (!rider.live || rider.dispose !== undefined) return;
	rider.dispose = rider.register();
}

function stopRider(rider: Rider): void {
	if (rider.dispose === undefined) return;
	const dispose = rider.dispose;
	rider.dispose = undefined;
	dispose();
}

/** Riders of a now-live seat start rendering. */
function startQueued(entry: SeatEntry): void {
	const queued = [...entry.queued];
	entry.queued.clear();
	for (const rider of queued) {
		entry.riding.add(rider);
		startRider(rider);
	}
}

/** A seat went away: dispose what rides it and queue those riders for its return. */
function collapse(slot: string, entry: SeatEntry): void {
	entry.ownerId = undefined;
	const riding = [...entry.riding];
	entry.riding.clear();
	for (const rider of riding) {
		stopRider(rider);
		if (rider.live) entry.queued.add(rider);
	}
	// A seat nobody waits for leaves no trace; otherwise the entry (and its
	// queue) has to survive, or the next declaration has nobody to promote.
	if (entry.queued.size === 0) seats.delete(slot);
	notify(slot);
}

/**
 * Declare the seats a component renders.
 *
 * Declaring a seat another component owns throws; the seats this call already
 * claimed are released first, so a failed declaration leaves nothing half-live.
 */
export function declareSeats(ownerId: string, slots: readonly string[]): () => void {
	const claimed: string[] = [];
	for (const slot of slots) {
		const existing = seats.get(slot);
		if (existing !== undefined && existing.ownerId !== undefined && existing.ownerId !== ownerId) {
			for (const claimedSlot of claimed) {
				const entry = seats.get(claimedSlot);
				if (entry !== undefined) collapse(claimedSlot, entry);
			}
			throw new Error(`seat "${slot}" is already declared by ${existing.ownerId}`);
		}
		entryFor(slot).ownerId = ownerId;
		claimed.push(slot);
	}
	for (const slot of claimed) {
		const entry = entryFor(slot);
		startQueued(entry);
		notify(slot);
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const slot of claimed) {
			const entry = seats.get(slot);
			if (entry !== undefined && entry.ownerId === ownerId) collapse(slot, entry);
		}
	};
}

/** Declare the process-lifetime seats the app shell always renders. */
export function declareCoreSeats(slots: readonly string[]): () => void {
	for (const slot of slots) {
		entryFor(slot).ownerId = null;
		startQueued(entryFor(slot));
		notify(slot);
	}
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		for (const slot of slots) {
			const entry = seats.get(slot);
			if (entry !== undefined && entry.ownerId === null) collapse(slot, entry);
		}
	};
}

/**
 * Ride a seat for its whole declaration lifetime.
 *
 * `register` runs now when the seat is live, or the first time it becomes live,
 * and again after every collapse of that seat. The returned disposer stops the
 * contributor for good: it leaves both the riding and the queued sets.
 */
export function injectSeat(slot: string, register: () => () => void): () => void {
	const entry = entryFor(slot);
	const rider: Rider = { register, dispose: undefined, live: true };
	if (isSeatDeclared(slot)) {
		entry.riding.add(rider);
		startRider(rider);
	} else {
		entry.queued.add(rider);
	}
	return () => {
		rider.live = false;
		entry.queued.delete(rider);
		entry.riding.delete(rider);
		stopRider(rider);
	};
}

/** Drop every seat and every rider (process teardown, tests). */
export function resetSeats(): void {
	for (const [slot, entry] of [...seats]) {
		seats.delete(slot);
		entry.ownerId = undefined;
		for (const rider of [...entry.riding]) {
			rider.live = false;
			stopRider(rider);
		}
		entry.riding.clear();
		for (const rider of entry.queued) rider.live = false;
		entry.queued.clear();
		notify(slot);
	}
	listeners.clear();
}
