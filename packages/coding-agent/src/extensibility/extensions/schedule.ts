/**
 * Session-scoped reminders for extensions (`ctx.schedule`).
 *
 * This is the lightweight sibling of the daemon cron store (`daemon/crons.ts`,
 * durable across restarts, runs prompts in fresh sessions): schedules live
 * and die with the owning session, need no daemon, and deliver into the
 * session itself as a follow-up user turn. Calendar-grade recurrence
 * (daily/weekly/cron/timezone) stays with daemon cron; this covers one-shots
 * (`afterSeconds`/`at`) and fixed intervals (`everySeconds`).
 *
 * The driver is owned by the extension runner: a 1s managed timer calls
 * {@link ExtensionScheduler.drive}, which fires due records through the
 * supplied `deliver` (the runner's `sendUserMessage` with
 * `deliverAs: "followUp"`). One-shot records are consumed on fire; recurring
 * ones advance to the next slot past now, so downtime collapses to a single
 * delivery instead of a backlog.
 * A delivery throw keeps the record due and moves on to the rest.
 */

export interface ScheduleCreate {
	/** Reminder text delivered as a follow-up user turn. 1..20000 chars. */
	prompt: string;
	/** Short label shown in lists and the delivery framing. */
	title?: string;
	/** Fire once this many seconds from now. Mutually exclusive with `at`. */
	afterSeconds?: number;
	/** Fire once at this epoch-ms or date string. Mutually exclusive. */
	at?: number | string;
	/** Fire every this many seconds, starting now + interval. */
	everySeconds?: number;
}

export interface ScheduleRecord {
	readonly id: string;
	readonly prompt: string;
	readonly title?: string;
	readonly kind: "once" | "every";
	readonly nextAt: number;
	readonly everyMs?: number;
	readonly createdAt: number;
}

export interface ScheduleUpdate {
	prompt?: string;
	title?: string;
	afterSeconds?: number;
	at?: number | string;
	everySeconds?: number;
}

export type ScheduleDeliver = (record: ScheduleRecord) => void;

/** Frame a fired reminder as the follow-up turn text (shared by all drivers). */
export function frameScheduledPrompt(record: Pick<ScheduleRecord, "prompt" | "title">): string {
	const head = record.title !== undefined ? `[scheduled reminder: ${record.title}]\n` : "[scheduled reminder]\n";
	return `${head}${record.prompt}`;
}

const MAX_PROMPT = 20_000;

function fail(message: string): never {
	throw new Error(`invalid schedule: ${message}`);
}

function resolveTiming(
	input: Pick<ScheduleCreate, "afterSeconds" | "at" | "everySeconds">,
	now: number,
): { kind: "once" | "every"; nextAt: number; everyMs?: number } {
	const { afterSeconds, at, everySeconds } = input;
	const set = [afterSeconds !== undefined, at !== undefined, everySeconds !== undefined].filter(Boolean).length;
	if (set === 0) fail("one of afterSeconds, at, everySeconds is required");
	if (set > 1) fail("afterSeconds, at and everySeconds are mutually exclusive");
	if (afterSeconds !== undefined) {
		if (!Number.isFinite(afterSeconds) || afterSeconds <= 0) fail("afterSeconds must be > 0");
		return { kind: "once", nextAt: now + Math.round(afterSeconds * 1000) };
	}
	if (at !== undefined) {
		const atMs = typeof at === "number" ? at : Date.parse(at);
		if (!Number.isFinite(atMs)) fail("at must be epoch-ms or a parseable date");
		return { kind: "once", nextAt: Math.round(atMs) };
	}
	// everySeconds is the only remaining case (set === 1 checked above).
	const every = everySeconds as number;
	if (!Number.isFinite(every) || every <= 0) fail("everySeconds must be > 0");
	const everyMs = Math.round(every * 1000);
	return { kind: "every", nextAt: now + everyMs, everyMs };
}

function checkPrompt(prompt: string): string {
	if (typeof prompt !== "string" || prompt.length === 0) fail("prompt must be non-empty");
	if (prompt.length > MAX_PROMPT) fail(`prompt must be at most ${MAX_PROMPT} chars`);
	return prompt;
}

export class ExtensionScheduler {
	readonly #records = new Map<string, ScheduleRecord>();

	create(input: ScheduleCreate, now: number = Date.now()): ScheduleRecord {
		const prompt = checkPrompt(input.prompt);
		const timing = resolveTiming(input, now);
		const record: ScheduleRecord = {
			id: `sch_${crypto.randomUUID()}`,
			prompt,
			...(input.title !== undefined ? { title: input.title } : {}),
			...timing,
			createdAt: now,
		};
		this.#records.set(record.id, record);
		return { ...record };
	}

	list(): ScheduleRecord[] {
		return [...this.#records.values()].map(record => ({ ...record }));
	}

	update(id: string, patch: ScheduleUpdate, now: number = Date.now()): ScheduleRecord {
		const current = this.#records.get(id);
		if (!current) fail(`unknown schedule id "${id}"`);
		const nextTiming =
			patch.afterSeconds !== undefined || patch.at !== undefined || patch.everySeconds !== undefined
				? {
						...(patch.afterSeconds !== undefined ? { afterSeconds: patch.afterSeconds } : {}),
						...(patch.at !== undefined ? { at: patch.at } : {}),
						...(patch.everySeconds !== undefined ? { everySeconds: patch.everySeconds } : {}),
					}
				: current.kind === "every" && current.everyMs !== undefined
					? { everySeconds: current.everyMs / 1000 }
					: { at: current.nextAt };
		const prompt = checkPrompt(patch.prompt ?? current.prompt);
		const timing = resolveTiming(nextTiming, now);
		const record: ScheduleRecord = {
			id,
			prompt,
			...(patch.title !== undefined
				? { title: patch.title }
				: current.title !== undefined
					? { title: current.title }
					: {}),
			...timing,
			createdAt: current.createdAt,
		};
		this.#records.set(id, record);
		return { ...record };
	}

	delete(id: string): boolean {
		return this.#records.delete(id);
	}

	/**
	 * Fire every record due at `nowMs` through `deliver`.
	 *
	 * @returns ids that fired (including ones whose delivery threw — those
	 * stay due and fire again on the next drive).
	 */
	drive(nowMs: number, deliver: ScheduleDeliver): string[] {
		const fired: string[] = [];
		for (const record of this.#records.values()) {
			if (record.nextAt > nowMs) continue;
			try {
				deliver({ ...record });
			} catch {
				continue;
			}
			fired.push(record.id);
			if (record.kind === "once" || record.everyMs === undefined) {
				this.#records.delete(record.id);
				continue;
			}
			let nextAt = record.nextAt;
			while (nextAt <= nowMs) nextAt += record.everyMs;
			this.#records.set(record.id, { ...record, nextAt });
		}
		return fired;
	}
}
