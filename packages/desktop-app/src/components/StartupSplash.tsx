import { BlurText, StatusText, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ThinkingOrb } from "../vendor/thinking-orbs";
import { SplashOrb } from "./SplashOrb";

/** Boot stage the shell is currently in. Owned by app.tsx boot(); the splash
 *  only names it so a slow start shows WHERE it is stuck rather than a
 *  featureless hold. */
export type BootPhase = "probe" | "spawn" | "gate" | "connect";

/** Default gate for `useSlowBoot` when no per-phase budget applies. A warm
 *  daemon connects in ~150ms, so this never fires on the common path. */
const SLOW_BOOT_MS = 8_000;

/** Three display states, not a binary slow/fast split. `slow` is informational;
 *  only `stalled` may claim the daemon is stuck and offer recovery controls. */
export type BootStatus = "normal" | "slow" | "stalled";

export type BootTimings = {
	/** Budget per phase before the line turns informational. Phases cost
	 *  different amounts of work: spawning a daemon and running the version /
	 *  capability gate are far slower than a port probe or a WS handshake. */
	budgets: Record<BootPhase, number>;
	/** Extra time past a phase budget before that phase is called stalled. */
	stallExtraMs: number;
	/** Whole-boot backstop: a boot that keeps advancing through phases but
	 *  never finishes must still surface recovery eventually. */
	totalStallMs: number;
};

/** Production budgets, overridable in tests via `useBootStatus`'s third arg. */
export const BOOT_TIMINGS: BootTimings = {
	budgets: { probe: 8_000, spawn: 20_000, gate: 15_000, connect: 8_000 },
	stallExtraMs: 15_000,
	totalStallMs: 60_000,
};

/** Orb hand-off after the shell becomes ready: the booting particle orb
 *  cross-fades into the static brand sphere, and the splash stays mounted
 *  for exactly that long so the hand-off is seen rather than cut. */
export const SPLASH_HANDOFF_MS = 300;

/** Same key main.tsx appends uncaught renderer errors to. Read here at
 *  export time so a broken renderer can hand the trace to the shell even
 *  when the daemon connection never came up. */
const ERROR_LOG_KEY = "musepi-gui-error-log";

const PHASE_KEYS = {
	probe: "general.bootPhaseProbe",
	spawn: "general.bootPhaseSpawn",
	gate: "general.bootPhaseGate",
	connect: "general.bootPhaseConnect",
} as const;

export function bootPhaseLabel(phase: BootPhase): string {
	return t(PHASE_KEYS[phase]);
}

/**
 * Uncaught renderer errors recorded by main.tsx, oldest first. A missing or
 * corrupt ring is an empty history: this runs while the app is already
 * unhealthy, so it must never throw a second failure into the recovery UI.
 */
export function readRendererErrorLog(
	storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): string[] {
	if (!storage) return [];
	try {
		const parsed: unknown = JSON.parse(storage.getItem(ERROR_LOG_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((line): line is string => typeof line === "string").slice(-100);
	} catch {
		return [];
	}
}

export type DiagnosticsExportResult = { ok: true; path: string } | { ok: false; error: string };

/** Ask the shell to bundle logs + system info + the renderer error ring.
 *  Resolves the absolute report path the shell actually wrote. */
export async function exportDiagnostics(): Promise<DiagnosticsExportResult> {
	const bridge = window.electronAPI;
	if (!bridge?.diagnosticsExport) return { ok: false, error: t("general.bootDiagnosticsUnavailable") };
	try {
		return await bridge.diagnosticsExport({ errors: readRendererErrorLog() });
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Relaunch through the shell's quit path (owned daemon torn down first).
 *  False when there is no Electron shell to ask. */
export async function restartApplication(): Promise<boolean> {
	const bridge = window.electronAPI;
	if (!bridge?.appRestart) return false;
	await bridge.appRestart();
	return true;
}

/**
 * Slow-boot gate: true once `enabled` has stayed set for `delayMs`. A changed
 * `resetKey` (the boot phase) starts a fresh window, and a retry (enabled
 * false → true) does the same. Time spent in one state is never charged to
 * the next one.
 */
export function useSlowBoot(enabled: boolean, delayMs: number = SLOW_BOOT_MS, resetKey?: string): boolean {
	const [slow, setSlow] = useState(false);
	useEffect(() => {
		setSlow(false);
		if (!enabled) return;
		const timer = setTimeout(() => setSlow(true), delayMs);
		return () => clearTimeout(timer);
	}, [enabled, delayMs, resetKey]);
	return slow;
}

/**
 * Per-phase watchdog. Both thresholds restart when the phase changes, so a
 * slow-but-progressing boot never accumulates into a false "daemon stuck".
 * The whole-boot timer is the only phase-independent backstop.
 */
export function useBootStatus(booting: boolean, phase: BootPhase, timings: BootTimings = BOOT_TIMINGS): BootStatus {
	const budget = timings.budgets[phase];
	const slow = useSlowBoot(booting, budget, phase);
	const phaseStalled = useSlowBoot(booting, budget + timings.stallExtraMs, phase);
	const totalStalled = useSlowBoot(booting, timings.totalStallMs);
	return totalStalled || phaseStalled ? "stalled" : slow ? "slow" : "normal";
}

/**
 * Keeps the splash mounted through the orb hand-off: true while booting, then
 * for one SPLASH_HANDOFF_MS cross-fade after the shell became ready. A boot
 * that restarts (reconnect) takes the hold back immediately.
 */
export function useSplashHold(booting: boolean): boolean {
	const [hold, setHold] = useState(booting);
	useEffect(() => {
		if (booting) {
			setHold(true);
			return;
		}
		const timer = setTimeout(() => setHold(false), SPLASH_HANDOFF_MS);
		return () => clearTimeout(timer);
	}, [booting]);
	return hold;
}

/**
 * Recovery controls shared by the splash and the connect-failure page: the
 * same two actions must work before a daemon connection exists, which is
 * why both are shell IPC calls and not daemon RPCs.
 */
export function BootRecoveryActions(): ReactNode {
	const [busy, setBusy] = useState<"export" | "restart" | null>(null);
	const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);

	const runExport = async (): Promise<void> => {
		setBusy("export");
		setStatus(null);
		const result = await exportDiagnostics();
		setBusy(null);
		setStatus(
			result.ok
				? { text: t("general.bootDiagnosticsSaved", { path: result.path }), failed: false }
				: { text: t("general.bootDiagnosticsFailed", { error: result.error }), failed: true },
		);
	};

	const runRestart = async (): Promise<void> => {
		setBusy("restart");
		setStatus(null);
		try {
			if (!(await restartApplication())) {
				setBusy(null);
				setStatus({ text: t("general.bootRestartUnavailable"), failed: true });
				return;
			}
			// The process is exiting; keep the controls disabled until it does.
			setStatus({ text: t("general.bootRestarting"), failed: false });
		} catch (err) {
			// The IPC rejected: the shell is still alive, so re-enable the
			// controls instead of leaving them disabled forever.
			setBusy(null);
			setStatus({
				text: t("general.bootRestartFailed", { error: err instanceof Error ? err.message : String(err) }),
				failed: true,
			});
		}
	};

	return (
		<>
			<button className="gui-btn" type="button" disabled={busy !== null} onClick={() => void runExport()}>
				{t("general.bootExportDiagnostics")}
			</button>
			<button
				className="gui-btn gui-btn-primary"
				type="button"
				disabled={busy !== null}
				onClick={() => void runRestart()}
			>
				{t("general.bootRestartApp")}
			</button>
			{status && (
				<p className={status.failed ? "gui-error" : "gui-note"} role="status">
					{status.text}
				</p>
			)}
		</>
	);
}

/** Settings → 常规 motion switch. The boot orb holds a static frame for
 *  those users instead of running its particle loop. */
function motionOff(): boolean {
	try {
		return localStorage.getItem("musepi-gui-motion") === "off";
	} catch {
		return false;
	}
}

export function StartupSplash({
	phase,
	status,
	slow = false,
	ready = false,
}: {
	phase?: BootPhase;
	/** Three-level status from `useBootStatus`. */
	status?: BootStatus;
	/** Compatibility alias: the boolean view maps to `stalled`. */
	slow?: boolean;
	ready?: boolean;
} = {}): ReactNode {
	const [paused] = useState(motionOff);
	const level: BootStatus = status ?? (slow ? "stalled" : "normal");
	const notice =
		level === "slow" ? t("general.bootPhaseSlow") : level === "stalled" ? t("general.bootTakingLongerThan") : null;
	return (
		<div className="gui-splash">
			<div className="gui-splash-inner">
				{/* Boot is the particle orb; `ready` cross-fades it into the static
				 *  brand sphere — the same sphere the desktop pet settles into.
				 *  The sphere stays in flow (it alone defines the orb box), so the
				 *  splash layout is identical before and after the hand-off. */}
				<div className={`gui-splash-orb${ready ? " gui-splash-orb--ready" : ""}`}>
					<div className="gui-splash-orb-particles" aria-hidden="true">
						<ThinkingOrb state="working" size={64} paused={paused} style={{ width: "100%", height: "100%" }} />
					</div>
					<div className="gui-splash-orb-sphere">
						<SplashOrb />
					</div>
				</div>
				<BlurText text="MusePi" className="gui-splash-wordmark" stepMs={55} />
				<div className="gui-splash-progress-track" aria-hidden="true">
					<span className="gui-splash-progress-fill" />
				</div>
				<progress className="gui-splash-progress-native" aria-label={t("settings.loading")} />
				{/* Both lines are fixed status slots: phase → phase and notice →
				 *  notice cross-fade in place, never a hard text swap or a jump. */}
				<div className="gui-splash-status">
					<StatusText className="gui-note" text={phase ? bootPhaseLabel(phase) : null} />
					<StatusText className={`gui-note${level === "stalled" ? " gui-error" : ""}`} text={notice} />
				</div>
				{level === "stalled" && (
					<div className="gui-splash-recovery">
						<BootRecoveryActions />
					</div>
				)}
			</div>
		</div>
	);
}
