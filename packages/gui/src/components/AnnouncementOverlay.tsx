import { getLocaleSnapshot, Markdown, t } from "@musepi/desktop-web";
import { Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { onboardingPending } from "../lib/onboarding";
import type { RpcClient } from "../lib/rpc";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";

/** Exit animation duration (mirrors gui-obo-card-out in gui-widgets.css). */
const ANNOUNCEMENT_EXIT_MS = 200;

/**
 * Release-notes announcement panel (what's-new push for future features).
 *
 * Extracted from the onboarding primer pattern: the same frosted overlay +
 * card shell, but driven by the daemon's changelog machinery instead of the
 * setup steps. On startup it asks the daemon for release notes newer than
 * the last seen version (daemon changelog.startup) and for the npm
 * latest-version probe (updates.check). The daemon persists the seen marker
 * (shared with the TUI — whichever surface runs first consumes the notes),
 * so this panel shows once per upgrade. The settings-footer 查看新功能
 * button re-opens it with force=true (peek, marker untouched).
 */
export function AnnouncementOverlay({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [open, setOpen] = useState(false);
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [latest, setLatest] = useState<string | null>(null);
	const enteredCls = useTwoPhaseEnter(open);
	// Stay mounted through the exit so the fade-out plays instead of cutting.
	const [closing, setClosing] = useState(false);

	const requestClose = useCallback((): void => {
		setClosing(true);
		setTimeout(() => {
			setOpen(false);
			setClosing(false);
		}, ANNOUNCEMENT_EXIT_MS);
	}, []);

	useEffect(() => {
		if (!rpc) return;
		let cancelled = false;
		const markdownRef = { current: "" };
		const openRef = { current: false };
		void (async () => {
			try {
				const [changelog, updates] = await Promise.all([
					rpc.request<{ markdown?: string; latestVersion?: string } | null>("changelog.startup", {
						locale: getLocaleSnapshot(),
					}),
					rpc.request<{ latest?: string } | null>("updates.check", {}),
				]);
				if (cancelled) return;
				const md = changelog?.markdown ?? null;
				markdownRef.current = md ?? "";
				setMarkdown(md);
				setLatest(updates?.latest ?? null);
				// The primer owns the first-run experience — defer to it.
				if (md && !onboardingPending()) {
					openRef.current = true;
					setOpen(true);
				}
			} catch {
				// network/daemon hiccup: stay silent, never block startup
			}
		})();
		// The primer finishing mid-session releases the announcement we
		// deferred earlier (first launch → onboarding → what's new).
		const onPrimerDone = (): void => {
			if (markdownRef.current && !openRef.current) {
				openRef.current = true;
				setOpen(true);
			}
		};
		window.addEventListener("omp-onboarding-finished", onPrimerDone);
		return () => {
			cancelled = true;
			window.removeEventListener("omp-onboarding-finished", onPrimerDone);
		};
	}, [rpc]);

	// Settings footer 查看新功能 re-opens on demand (force peek).
	useEffect(() => {
		if (!rpc) return;
		const onOpen = (): void => {
			void rpc
				.request<{ markdown?: string; latestVersion?: string } | null>("changelog.startup", { force: true, locale: getLocaleSnapshot() })
				.then(changelog => {
					if (!changelog?.markdown) return;
					setMarkdown(changelog.markdown);
					setLatest(null);
					setOpen(true);
				})
				.catch(() => {});
		};
		window.addEventListener("omp-open-announcement", onOpen);
		return () => window.removeEventListener("omp-open-announcement", onOpen);
	}, [rpc]);

	// Keyboard priority: Escape closes the announcement — the page behind
	// must not keep focus/keys while this overlay is up. Declared BEFORE
	// the early return (hooks rule: no hook may follow a conditional
	// return, or the hook count flips between renders).
	useEffect(() => {
		if (!open || !markdown) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				requestClose();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, markdown, requestClose]);

	if (!open || !markdown) return null;
	return (
		<div className={`gui-onboarding-backdrop${enteredCls ? " gui-onboarding-backdrop--entered" : ""}${closing ? " gui-onboarding-backdrop--closing" : ""}`}>
			<div className={`gui-onboarding-card gui-announcement-card${closing ? " gui-onboarding-card--closing" : ""}`}>
				<div className="gui-onboarding-topbar">
					<div className="gui-onboarding-badge">
						<Sparkles size={14} />
						{t("what's new")}
					</div>
					<button
						className="gui-btn gui-btn-icon"
						type="button"
						onClick={requestClose}
						aria-label={t("close")}
					>
						<X size={16} />
					</button>
				</div>
				<div className="gui-announcement-title">
					{t("what's new in MusePi")}
					{latest && (
						<span className="gui-announcement-latest">
							{t("discover new version")} v{latest}
						</span>
					)}
				</div>
				<div className="gui-announcement-body">
					<Markdown text={markdown} />
				</div>
				<div className="gui-onboarding-actions">
					<button className="gui-btn gui-btn-primary" type="button" onClick={requestClose}>
						{t("got it")}
					</button>
				</div>
			</div>
		</div>
	);
}
