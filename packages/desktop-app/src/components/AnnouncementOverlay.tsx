import { getLocaleSnapshot, Markdown, t } from "@musepi/client-core";
import {
	type ChangelogHighlight,
	type ChangelogHighlightKind,
	type ChangelogVersion,
	parseChangelogHighlights,
} from "@musepi/client-core/src/lib/changelog-highlights";
import { ChevronDown, ChevronRight, ExternalLink, Palette, Sparkles, Trash2, Wrench, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openExternalUrl } from "../lib/electron";
import { onboardingPending } from "../lib/onboarding";
import { activePet } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { PetSprite } from "./PetSprite";
import { RewardOverlay, type RewardPayload } from "./RewardOverlay";

/** Exit animation duration (mirrors gui-obo-card-out in gui-widgets.css). */
const ANNOUNCEMENT_EXIT_MS = 180;
/** Cap for the advisory network probes on the boot path (see withTimeout). */
const UPDATE_CHECK_TIMEOUT_MS = 4000;
/** GitHub releases page — same source as UpdateToast/UpdateDialog's RELEASES_PAGE. */
const RELEASES_PAGE = "https://github.com/MuseLinn/MusePi/releases/latest";

/** changelog.startup payload — release notes plus an optional campaign
 *  reward (rendered as the celebratory ticket overlay instead). */
interface StartupChangelog {
	markdown?: string;
	latestVersion?: string;
	reward?: RewardPayload | null;
}

/** Kind → icon for the highlight cards (Added✨/Fixed🔧/Changed🎨/Removed🗑). */
const KIND_ICONS: Record<ChangelogHighlightKind, typeof Sparkles> = {
	added: Sparkles,
	fixed: Wrench,
	changed: Palette,
	removed: Trash2,
};

/* ── Inline styles for the structured highlight cards ─────────────────────
 * The allowed-file scope for this change excludes the stylesheets, so the
 * new structural surfaces compose token variables ONLY (zero new visual
 * tokens) inside the component file; the shell classes
 * (gui-onboarding-*, gui-announcement-*) stay untouched. */
const HIGHLIGHT_CARD_STYLE: CSSProperties = {
	display: "flex",
	alignItems: "flex-start",
	gap: 10,
	padding: "10px 12px",
	margin: "0 0 8px",
	border: "1px solid var(--border)",
	borderRadius: "var(--radius-lg)",
	background: "color-mix(in oklab, var(--fg) 4%, transparent)",
};
const HIGHLIGHT_ICON_STYLE: CSSProperties = { flexShrink: 0, color: "var(--accent)", marginTop: 2 };
const HIGHLIGHT_TITLE_STYLE: CSSProperties = { fontWeight: 600, color: "var(--fg)", lineHeight: 1.45 };
const HIGHLIGHT_DESC_STYLE: CSSProperties = {
	display: "-webkit-box",
	WebkitBoxOrient: "vertical",
	WebkitLineClamp: 2,
	overflow: "hidden",
	color: "var(--fg-muted)",
	fontSize: 12.5,
	lineHeight: 1.55,
};
const FOLD_ROW_STYLE: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 6,
	width: "100%",
	padding: "8px 10px",
	margin: "4px 0 8px",
	border: "none",
	borderRadius: "var(--radius-md)",
	background: "color-mix(in oklab, var(--fg) 6%, transparent)",
	color: "var(--fg-muted)",
	fontSize: 12.5,
	fontWeight: 550,
	cursor: "pointer",
	textAlign: "left",
};
const VERSION_ROW_STYLE: CSSProperties = { marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 };
const COUNT_BADGE_STYLE: CSSProperties = {
	flexShrink: 0,
	padding: "1px 8px",
	borderRadius: "var(--radius-xl)",
	fontSize: 11,
	fontWeight: 550,
	color: "var(--accent)",
	background: "color-mix(in oklab, var(--accent) 14%, transparent)",
};
const DATE_STYLE: CSSProperties = { fontSize: 12, color: "var(--fg-muted)" };

/** Reduced-motion probe read once per open: under gui-motion-off /
 *  prefers-reduced-motion the celebrate sprite is dropped entirely (the
 *  builtin engine animates on rAF, and §5u demands no intermediate frames). */
function motionOff(): boolean {
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/** One structured highlight card: kind icon + bold title + ≤2-line
 *  description (the parser already provides only the first sentence; the
 *  CSS clamp is the display-side truncation). */
function HighlightCard({ highlight }: { highlight: ChangelogHighlight }): ReactNode {
	const Icon = KIND_ICONS[highlight.kind];
	return (
		<div style={HIGHLIGHT_CARD_STYLE}>
			<Icon size={15} style={HIGHLIGHT_ICON_STYLE} aria-hidden />
			<div style={{ minWidth: 0, display: "grid", gap: 2 }}>
				<div style={HIGHLIGHT_TITLE_STYLE}>{highlight.title}</div>
				{highlight.description && <div style={HIGHLIGHT_DESC_STYLE}>{highlight.description}</div>}
			</div>
		</div>
	);
}

/** Older-release collapsible row: version + date + per-kind count badge,
 *  expanding to that section's raw markdown rendering. */
function OlderVersionRow({
	entry,
	expanded,
	onToggle,
}: {
	entry: ChangelogVersion;
	expanded: boolean;
	onToggle(): void;
}): ReactNode {
	const total = entry.counts.added + entry.counts.fixed + entry.counts.changed + entry.counts.removed;
	const Chevron = expanded ? ChevronDown : ChevronRight;
	return (
		<div style={VERSION_ROW_STYLE}>
			<button type="button" style={FOLD_ROW_STYLE} onClick={onToggle} aria-expanded={expanded}>
				<Chevron size={13} aria-hidden />
				<span style={{ fontWeight: 600, color: "var(--fg)" }}>v{entry.version}</span>
				{entry.date && <span style={DATE_STYLE}>{entry.date}</span>}
				<span style={COUNT_BADGE_STYLE}>{t("{count} changes", { count: total })}</span>
			</button>
			{expanded && <Markdown text={entry.markdown} />}
		</div>
	);
}

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
 *
 * The markdown is parsed client-side (parseChangelogHighlights) into the
 * structured view: a celebrate-pet header, ≤3 highlight cards for the
 * current version, a collapsed "N more fixes" row that lazily mounts the
 * full markdown, and collapsible older-release rows. When the parse yields
 * nothing (empty / no version sections) the panel falls back to the
 * original raw markdown rendering — never a blank card.
 */
/** Boot must never wait on a network probe: the update check is advisory
 * (it only feeds the "latest version" line), so cap it — measured at >8s with
 * a cold/blocked network, and Promise.all below would otherwise hold the
 * what's-new card hostage to it. Resolves null on timeout or failure. */
function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
	return Promise.race([
		p.catch(() => null),
		new Promise<null>(resolve => {
			setTimeout(() => resolve(null), ms);
		}),
	]);
}

export function AnnouncementOverlay({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [open, setOpen] = useState(false);
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [reward, setReward] = useState<RewardPayload | null>(null);
	const [latest, setLatest] = useState<string | null>(null);
	const [pet] = useState(() => activePet());
	// Structured-view UI state, reset on every open (the peek re-open may
	// serve different markdown than the boot push).
	const [showFullLog, setShowFullLog] = useState(false);
	const [expandedVersions, setExpandedVersions] = useState<ReadonlySet<string>>(() => new Set());
	const [reducedMotion, setReducedMotion] = useState(false);
	const cardRef = useRef<HTMLDivElement | null>(null);
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
		const rewardRef = { current: null as RewardPayload | null };
		const openRef = { current: false };
		void (async () => {
			try {
				const [changelog, updates] = await Promise.all([
					rpc.request<StartupChangelog | null>("changelog.startup", {
						locale: getLocaleSnapshot(),
					}),
					withTimeout(rpc.request<{ latest?: string } | null>("updates.check", {}), UPDATE_CHECK_TIMEOUT_MS),
				]);
				if (cancelled) return;
				const md = changelog?.markdown ?? null;
				const rw = changelog?.reward ?? null;
				markdownRef.current = md ?? "";
				rewardRef.current = rw;
				setMarkdown(md);
				setReward(rw);
				setLatest(updates?.latest ?? null);
				// The primer owns the first-run experience — defer to it.
				if ((md || rw) && !onboardingPending()) {
					openRef.current = true;
					setOpen(true);
				}
			} catch {
				// network/daemon hiccup: stay silent, never block startup
			}
		})();
		// The primer finishing mid-session releases the announcement we
		// deferred earlier (first launch → onboarding → what's new) — EXCEPT
		// on the very first run: a brand-new user has no "previous version",
		// so the what's-new card is skipped this session (it shows normally
		// from the next launch, when the primer no longer owns the flow).
		const onPrimerDone = (e: Event): void => {
			if ((e as CustomEvent<{ firstRun?: boolean }>).detail?.firstRun) return;
			if ((markdownRef.current || rewardRef.current) && !openRef.current) {
				openRef.current = true;
				setOpen(true);
			}
		};
		window.addEventListener("musepi-onboarding-finished", onPrimerDone);
		return () => {
			cancelled = true;
			window.removeEventListener("musepi-onboarding-finished", onPrimerDone);
		};
	}, [rpc]);

	// Settings footer 查看新功能 re-opens on demand (force peek).
	useEffect(() => {
		if (!rpc) return;
		const onOpen = (): void => {
			void rpc
				.request<StartupChangelog | null>("changelog.startup", {
					force: true,
					locale: getLocaleSnapshot(),
				})
				.then(changelog => {
					if (!changelog?.markdown && !changelog?.reward) return;
					setMarkdown(changelog.markdown ?? null);
					setReward(changelog.reward ?? null);
					setLatest(null);
					setOpen(true);
				})
				.catch(() => {});
		};
		window.addEventListener("musepi-open-announcement", onOpen);
		return () => window.removeEventListener("musepi-open-announcement", onOpen);
	}, [rpc]);

	// Per-open reset: folds collapse again and the reduced-motion probe is
	// re-read (the class can change while the app is running).
	useEffect(() => {
		if (!open) return;
		setShowFullLog(false);
		setExpandedVersions(new Set());
		setReducedMotion(motionOff());
	}, [open]);

	// Focus contract (§5u): opening moves focus to the primary action
	// (confirm-dialog precedent — the card itself is the tabIndex=-1
	// fallback), closing restores the previously focused element.
	useEffect(() => {
		if (!open) return;
		const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const raf = requestAnimationFrame(() => {
			const card = cardRef.current;
			if (!card) return;
			const primary = card.querySelector<HTMLElement>(".gui-btn-primary");
			(primary ?? card).focus();
		});
		return () => {
			cancelAnimationFrame(raf);
			prevActive?.focus();
		};
	}, [open]);

	// Keyboard priority: Escape closes and Enter confirms (= close, the
	// confirm-dialog contract) — the page behind must not keep focus/keys
	// while this overlay is up. Enter is skipped when the focus already
	// sits on a button (that click fires natively). Declared BEFORE the
	// early return (hooks rule: no hook may follow a conditional return,
	// or the hook count flips between renders).
	useEffect(() => {
		if (!open || (!markdown && !reward)) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				requestClose();
				return;
			}
			if (
				e.key === "Enter" &&
				!(e.target instanceof HTMLButtonElement) &&
				!(e.target instanceof HTMLInputElement) &&
				!(e.target instanceof HTMLTextAreaElement)
			) {
				e.preventDefault();
				e.stopPropagation();
				requestClose();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, markdown, reward, requestClose]);

	const toggleVersion = useCallback((version: string): void => {
		setExpandedVersions(prev => {
			const next = new Set(prev);
			if (next.has(version)) {
				next.delete(version);
			} else {
				next.add(version);
			}
			return next;
		});
	}, []);

	if (!open) return null;
	if (reward) return <RewardOverlay payload={reward} onClose={requestClose} />;
	if (!markdown) return null;

	const versions = parseChangelogHighlights(markdown);
	const current = versions[0];
	// Parse fell through (no version sections) → keep the original raw
	// markdown rendering; never a blank card.
	if (!current) {
		return (
			<div
				className={`gui-onboarding-backdrop${enteredCls ? " gui-onboarding-backdrop--entered" : ""}${closing ? " gui-onboarding-backdrop--closing" : ""}`}
			>
				<div
					className={`gui-onboarding-card gui-announcement-card${closing ? " gui-onboarding-card--closing" : ""}`}
				>
					<div className="gui-onboarding-topbar">
						<div className="gui-onboarding-badge">
							<Sparkles size={14} />
							{t("what's new")}
						</div>
						<button className="gui-btn gui-btn-icon" type="button" onClick={requestClose} aria-label={t("close")}>
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

	const older = versions.slice(1);
	const currentTotal = current.counts.added + current.counts.fixed + current.counts.changed + current.counts.removed;
	const remaining = Math.max(0, currentTotal - current.highlights.length);

	return (
		<div
			className={`gui-onboarding-backdrop${enteredCls ? " gui-onboarding-backdrop--entered" : ""}${closing ? " gui-onboarding-backdrop--closing" : ""}`}
		>
			<div
				ref={cardRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label={t("what's new")}
				className={`gui-onboarding-card gui-announcement-card${closing ? " gui-onboarding-card--closing" : ""}`}
			>
				<div className="gui-onboarding-topbar">
					<div className="gui-onboarding-badge">
						<Sparkles size={14} />
						{t("what's new")}
					</div>
					<button className="gui-btn gui-btn-icon" type="button" onClick={requestClose} aria-label={t("close")}>
						<X size={16} />
					</button>
				</div>
				<div className="gui-announcement-title" style={{ gap: 14, padding: "16px 24px 12px" }}>
					{!reducedMotion && <PetSprite mood="rest" state="celebrate" pet={pet} size={44} />}
					<div style={{ minWidth: 0, display: "grid", gap: 4 }}>
						<div style={{ fontSize: 17, fontWeight: 650, letterSpacing: "-0.01em", color: "var(--fg)" }}>
							{t("MusePi updated to v{version}", { version: current.version })}
						</div>
						<div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
							{current.date && <span style={DATE_STYLE}>{current.date}</span>}
							{latest && (
								<span className="gui-announcement-latest">
									{t("discover new version")} v{latest}
								</span>
							)}
						</div>
					</div>
				</div>
				<div className="gui-announcement-body">
					{current.highlights.map(highlight => (
						<HighlightCard key={highlight.title} highlight={highlight} />
					))}
					{remaining > 0 && (
						<button
							type="button"
							style={FOLD_ROW_STYLE}
							onClick={() => setShowFullLog(v => !v)}
							aria-expanded={showFullLog}
						>
							{showFullLog ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
							{t("{count} more fixes and improvements", { count: remaining })}
						</button>
					)}
					{/* The full log mounts lazily — only after the fold opens. */}
					{showFullLog && <Markdown text={markdown} />}
					{older.length > 0 && (
						<div>
							<div style={{ ...DATE_STYLE, margin: "6px 0 2px", fontWeight: 600 }}>{t("older releases")}</div>
							{older.map(entry => (
								<OlderVersionRow
									key={entry.version}
									entry={entry}
									expanded={expandedVersions.has(entry.version)}
									onToggle={() => toggleVersion(entry.version)}
								/>
							))}
						</div>
					)}
				</div>
				<div className="gui-onboarding-actions">
					<button className="gui-btn" type="button" onClick={() => void openExternalUrl(RELEASES_PAGE)}>
						<ExternalLink size={14} aria-hidden />
						{t("view full changelog")}
					</button>
					<button className="gui-btn gui-btn-primary" type="button" onClick={requestClose}>
						{t("got it")}
					</button>
				</div>
			</div>
		</div>
	);
}
