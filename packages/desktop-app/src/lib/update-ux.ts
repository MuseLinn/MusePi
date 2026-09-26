/**
 * Shared update-UX signals for the two coexisting update surfaces
 * (UpdateToast + UpdateDialog, design §3.2 分层共存). Neither component
 * owns the other, so the cross-cutting facts live here:
 *
 *   - toastVisible   — whether the L-toast is currently showing (the
 *                      dialog's ≥10-min reboot nudge only fires while the
 *                      toast is closed).
 *   - installing     — a quitAndInstall is in its 15s grace window
 *                      (updater.cjs UPDATE_INSTALL_GRACE_MS): both surfaces
 *                      switch to the non-clickable "正在安装更新…" copy.
 *   - install failures — consecutive failed install attempts, shared so a
 *                      retry from either surface counts toward the ≥2
 *                      failure-decision-card threshold.
 *
 * Plain module state + listener set — no React, no external store lib;
 * components subscribe via useEffect and re-read the getters.
 */

import type { TranslationKey } from "@musepi/client-core";
import type { UpdateErrorInfo } from "./electron";
import { installUpdate } from "./electron";

type Listener = () => void;

/** Classified failure kind → localized body copy key (design §3.1-3: the
 *  main process ships only the stable kind enum; copy lives here). */
export const UPDATE_ERROR_BODY_KEYS: Record<UpdateErrorInfo["kind"], TranslationKey> = {
	check: "update error check",
	"check-network": "update error check-network",
	download: "update error download",
	"download-network": "update error download-network",
	install: "update error install",
	"install-network": "update error install-network",
};

let toastVisible = false;
let installing = false;
let installFailures = 0;

const listeners = new Set<Listener>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function subscribeUpdateUx(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Whether the update toast is currently rendered (not dismissed/closed). */
export function isUpdateToastVisible(): boolean {
	return toastVisible;
}

export function setUpdateToastVisible(visible: boolean): void {
	if (toastVisible === visible) return;
	toastVisible = visible;
	emit();
}

/** True during the quitAndInstall grace window (install underway). */
export function isUpdateInstalling(): boolean {
	return installing;
}

/** Consecutive failed install attempts (reset on a fresh download). */
export function getInstallFailureCount(): number {
	return installFailures;
}

export function resetInstallFailures(): void {
	installFailures = 0;
}

function setInstalling(value: boolean): void {
	if (installing === value) return;
	installing = value;
	emit();
}

/**
 * Trigger the install from either surface: flips both into the
 * non-clickable "installing" copy until the promise settles. On failure
 * the grace window ends and the consecutive-failure count increments
 * (the failure-decision card opens at ≥2).
 */
export async function requestUpdateInstall(): Promise<{ ok: boolean; error?: string }> {
	setInstalling(true);
	try {
		const result = await installUpdate();
		if (result.ok) {
			// App is shutting down; nothing left to notify about.
			return result;
		}
		installFailures += 1;
		return result;
	} catch (err) {
		installFailures += 1;
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		setInstalling(false);
	}
}
