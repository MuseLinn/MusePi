import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Live background-job state shared by the web/mobile shell and the desktop
 * composer.
 *
 * The daemon owns the jobs; this module only polls `session.jobs` while a
 * session is focused and the document is visible, and exposes cancel/output
 * without keeping a second source of truth. A poll failure keeps the last
 * snapshot: a transient reconnect must not empty the HUD and then rebuild it.
 */

export interface AsyncJobItem {
	id: string;
	type: string;
	status: string;
	label: string;
	startTime: number | string;
	/** Background `question` job: how many questions await an answer. */
	questionCount?: number;
	toolCallId?: string;
	/** Bytes retained in the job's live-output ring. */
	outputBytes?: number;
}

export interface AsyncJobsSnapshot {
	running: AsyncJobItem[];
	recent: AsyncJobItem[];
	delivery?: { queued?: number; delivering?: boolean | number; pendingJobIds?: string[] };
}

/** Minimal RPC surface both the shared client and the desktop RPC client satisfy. */
export interface JobsRpc {
	request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const POLL_MS = 1000;

export function useAsyncJobs(
	client: JobsRpc | null,
	sessionId: string | null,
	pollMs: number = POLL_MS,
): {
	snapshot: AsyncJobsSnapshot | null;
	running: AsyncJobItem[];
	refresh(): void;
	cancel(jobId: string): Promise<void>;
	loadOutput(jobId: string, tail?: number): Promise<{ output?: string; truncated?: boolean } | null>;
} {
	const [snapshot, setSnapshot] = useState<AsyncJobsSnapshot | null>(null);
	const disposed = useRef(false);

	const refresh = useCallback((): void => {
		if (!client || !sessionId) return;
		void client
			.request<AsyncJobsSnapshot>("session.jobs", { sessionId, recentLimit: 12 })
			.then(value => {
				if (!disposed.current) setSnapshot(value);
			})
			.catch(() => {
				// Keep the last authoritative snapshot across a reconnect.
			});
	}, [client, sessionId]);

	useEffect(() => {
		disposed.current = false;
		setSnapshot(null);
		if (!client || !sessionId) return;
		refresh();
		let timer = window.setInterval(() => {
			if (document.visibilityState === "visible") refresh();
		}, pollMs);
		const onVisibility = (): void => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			disposed.current = true;
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibility);
			timer = 0;
		};
	}, [client, sessionId, pollMs, refresh]);

	const cancel = useCallback(
		async (jobId: string): Promise<void> => {
			if (!client || !sessionId) return;
			try {
				await client.request("session.jobsCancel", { sessionId, jobId });
			} finally {
				refresh();
			}
		},
		[client, sessionId, refresh],
	);

	const loadOutput = useCallback(
		async (jobId: string, tail = 4000): Promise<{ output?: string; truncated?: boolean } | null> => {
			if (!client || !sessionId) return null;
			try {
				return await client.request<{ output?: string; truncated?: boolean }>("session.jobOutput", {
					sessionId,
					jobId,
					tail,
				});
			} catch {
				return null;
			}
		},
		[client, sessionId],
	);

	const running = useMemo(() => snapshot?.running ?? [], [snapshot]);
	return { snapshot, running, refresh, cancel, loadOutput };
}

/** Human label for a job's type, used in the chip and card headings. */
export function jobTypeLabel(type: string): string {
	switch (type) {
		case "bash":
			return "Bash";
		case "task":
			return "Task";
		case "question":
			return "Question";
		case "agnes-video":
			return "Video";
		default:
			return type.length > 0 ? type[0]!.toUpperCase() + type.slice(1) : "Job";
	}
}

/** Epoch-ms start time, tolerating the ISO strings older daemons emitted. */
export function jobStartMs(job: AsyncJobItem): number {
	const value = typeof job.startTime === "number" ? job.startTime : Date.parse(job.startTime);
	return Number.isFinite(value) ? value : Date.now();
}
