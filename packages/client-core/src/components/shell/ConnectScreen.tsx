import { ArrowUpRight, ChevronRight, KeyRound, Link2, Monitor, ScanLine, X } from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t, tLoose } from "../../i18n/index.js";
import { useLocale } from "../../i18n/use-locale.js";
import { useBackLayer } from "../../lib/back-stack";
import { isHarmonyShell } from "../../lib/capacitor";
import { haptic } from "../../lib/haptics";
import { addressParts, loadResolvedHosts, type ResolvedHost, removeHost } from "../../lib/hosts";
import { secureGet, secureSet } from "../../lib/secure-store";
import { canScanQr } from "../../lib/surface";
import { useCollapseHeight } from "../../lib/use-collapse";
import { AccentToggle } from "./AccentToggle";
import { BlurText } from "./BlurText";
import { DotMatrixMark } from "./DotMatrixMark";
import { LanguageToggle } from "./LanguageToggle";
import { QrScanner } from "./QrScanner";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	/** Deep-link fragment (a full collab link) pre-fills the input so a failed auto-connect still shows what to join. */
	defaultLink?: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

const PAIR_HOST_KEY = "musepi.collab.pairHost";
const SKIP_KEY = "musepi.collab.skipped";
/** Pre-rename spelling; read so a device that skipped earlier stays skipped. */
const LEGACY_SKIP_KEY = "omp-collab-skipped";
/** Pair endpoint port (daemon server.ts PAIR_PORT). */
const PAIR_PORT = 8301;

/**
 * A typed computer address as `host[:port]`.
 *
 * People paste what they see — `http://192.168.1.7`, a URL with a path, a
 * trailing slash — and the old `host.includes(":")` test turned those into
 * `ws://http://…` or `ws://1.2.3.4/:8301`, which threw a raw SyntaxError. Only
 * the host (and an explicit port) identify the pair endpoint, so the rest is
 * stripped here and the result is validated before a socket is opened.
 */
export function normalizePairHost(raw: string): string | null {
	let value = raw.trim();
	if (!value) return null;
	value = value.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, "");
	const [authority] = value.split(/[/?#]/, 1);
	if (!authority) return null;
	// IPv6 literals keep their brackets; everything else allows one optional port.
	const match = /^(\[[0-9a-fA-F:]+\]|[^:\s]+)(?::(\d{1,5}))?$/.exec(authority);
	if (!match) return null;
	const host = match[1]!;
	const port = match[2] ?? String(PAIR_PORT);
	return `${host}:${port}`;
}

/**
 * The collab link behind a scanned code, or null.
 *
 * A camera scans whatever is in front of it — a Wi-Fi join code, a product
 * barcode — and the old path connected with any string, so the guide closed and
 * a protocol error appeared as if MusePi itself had failed. `musepi://connect`
 * links (the same shape the Android deep link uses) are unwrapped; only a
 * transport URL survives.
 */
export function linkFromScannedCode(raw: string): string | null {
	const value = raw.trim();
	try {
		const url = new URL(value);
		if (url.protocol === "musepi:") {
			const link = url.searchParams.get("link") ?? url.searchParams.get("url");
			return link && /^(wss?|https?):\/\//i.test(link) ? link : null;
		}
	} catch {
		return null;
	}
	return /^(wss?|https?):\/\//i.test(value) ? value : null;
}

/** Resolve a 6-digit pair code against the daemon's LAN pair endpoint
 *  (pair.resolve) to obtain the full collab webLink. */
function resolvePairCodeOnLan(code: string, host: string): Promise<string> {
	const origin = normalizePairHost(host);
	if (!origin) return Promise.reject(new Error(t("settings.cannotReachComputerSame")));
	const url = `ws://${origin}`;
	return new Promise<string>((resolve, reject) => {
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch {
			reject(new Error(t("settings.cannotReachComputerSame")));
			return;
		}
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error(t("settings.pairCodeTimedOut")));
		}, 6000);
		ws.onopen = () => ws.send(JSON.stringify({ method: "pair.resolve", params: { code } }));
		ws.onmessage = e => {
			clearTimeout(timer);
			ws.close();
			try {
				const msg = JSON.parse(String(e.data)) as {
					result?: { webLink?: string };
					error?: { message?: string };
				};
				if (msg.result?.webLink) resolve(msg.result.webLink);
				else reject(new Error(msg.error?.message ?? t("settings.invalidExpiredPairCode")));
			} catch {
				reject(new Error(t("settings.invalidPairResponse")));
			}
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error(t("settings.cannotReachComputerSame")));
		};
	});
}

function SavedComputers({
	hosts,
	onConnect,
	onRemove,
}: {
	hosts: readonly ResolvedHost[];
	onConnect(host: ResolvedHost): void;
	onRemove(id: string): void;
}): ReactNode {
	if (hosts.length === 0) return null;
	return (
		<section className="sh-connect-recent" aria-label={t("settings.recentConnections")}>
			<div className="sh-connect-section-head">
				<span className="sh-field-label">{t("settings.recentConnections")}</span>
				<span className="sh-connect-count">{hosts.length}</span>
			</div>
			<div className="sh-connect-recent-list">
				{hosts.map((host, index) => {
					// The row used to print the address twice (label, then the same
					// address again with the relay hint), so two saved computers on
					// the same LAN read as identical lines. The subtitle now carries
					// the only distinguishing fact: the relay hint, or the address
					// itself.
					const parts = addressParts(host.candidates[0]?.address ?? "");
					// `deviceName` is the name the phone announced when it connected,
					// not the computer's — showing it labelled every saved machine
					// with this phone's name. The address is the fact that differs.
					const subtitle = parts.relay ? t("settings.hostPathRelay") : parts.host;
					return (
						<div
							key={host.id}
							className={`sh-connect-recent-item${index === 0 ? " sh-connect-recent-item--primary" : ""}`}
						>
							<button
								type="button"
								className="sh-connect-recent-main"
								title={`${host.label}${subtitle ? ` · ${subtitle}` : ""}`}
								onClick={() => onConnect(host)}
							>
								<span className="sh-connect-recent-icon" aria-hidden="true">
									<Monitor size={18} />
								</span>
								<span className="sh-connect-recent-copy">
									<span className="sh-connect-recent-name">{host.label}</span>
									{subtitle !== "" && <span className="sh-connect-recent-link">{subtitle}</span>}
								</span>
								<ArrowUpRight className="sh-connect-recent-open" size={16} aria-hidden="true" />
							</button>
							<button
								type="button"
								className="sh-btn sh-btn-icon sh-connect-recent-rm"
								title={t("general.remove")}
								aria-label={`${t("general.remove")} ${host.label}`}
								onClick={() => onRemove(host.id)}
							>
								<X size={15} />
							</button>
						</div>
					);
				})}
			</div>
		</section>
	);
}

/** Remote-workspace entry point. Saved computers are the fastest route;
 *  QR is the primary new-connection action, while pair codes and links are
 *  progressively disclosed alternatives. */
export function ConnectScreen({ defaultName, defaultLink, error, onConnect }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState(defaultLink ?? "");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);
	const [recent, setRecent] = useState<ResolvedHost[]>([]);
	const [pairCode, setPairCode] = useState("");
	const [pairHost, setPairHost] = useState("");
	const [pairBusy, setPairBusy] = useState(false);
	const [openMethod, setOpenMethod] = useState<"pair" | "link" | null>(null);
	const [scanning, setScanning] = useState(false);
	const [offline, setOffline] = useState(typeof navigator !== "undefined" && !navigator.onLine);
	const [skipped, setSkipped] = useState(() => {
		try {
			return localStorage.getItem(SKIP_KEY) === "1" || localStorage.getItem(LEGACY_SKIP_KEY) === "1";
		} catch {
			return false;
		}
	});
	// Accordion bodies stay mounted so open/close can animate height
	// (useCollapseHeight drives --h; see shell.css .sh-connect-collapse).
	const pairBodyRef = useRef<HTMLDivElement | null>(null);
	const linkBodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(openMethod === "pair", pairBodyRef);
	// Offline banner: the PWA shell stays readable from cache when the network
	// drops; make the state explicit so "paste a link" failures aren't a mystery.
	useEffect(() => {
		const on = (): void => setOffline(false);
		const off = (): void => setOffline(true);
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
		};
	}, []);
	// Subscribe this card to locale changes: every label below flows through
	// t(), which reads the store non-reactively — without a useLocale()
	// subscriber here, switching languages only re-renders the toggle button
	// and the rest of the guide keeps the old language until remount.
	useLocale();
	useCollapseHeight(openMethod === "link", linkBodyRef);

	// Resolve host credentials asynchronously; public metadata never contains
	// room keys. The same resolved records also drive startup restoration.
	useEffect(() => {
		let alive = true;
		void loadResolvedHosts().then(hosts => {
			if (alive) setRecent(hosts);
		});
		void secureGet(PAIR_HOST_KEY).then(host => {
			if (alive && host) setPairHost(host);
		});
		return () => {
			alive = false;
		};
	}, []);

	const connect = (target: string, who: string): void => {
		// Recording (host list + URL hash) happens in App.connect's onWelcome
		// hook, so a failed connect never pollutes the saved hosts.
		onConnect(target, who);
		haptic(12);
		// The native sheet stays open until the page accepts the submission
		// (HarmonyOS): a rejected code or unreachable host has to stay editable.
		if (isHarmonyShell()) window.harmonyNative?.closeConnectSheet?.();
	};

	const forgetHost = async (id: string): Promise<void> => {
		await removeHost(id);
		setRecent(await loadResolvedHosts());
	};

	const runPair = useCallback(
		async (rawCode: string, rawHost: string): Promise<void> => {
			const code = rawCode.trim();
			const host = rawHost.trim();
			if (!code || !host) {
				setLocalError(t("settings.enterPairCodeComputer"));
				return;
			}
			setPairBusy(true);
			setLocalError(null);
			try {
				const webLink = await resolvePairCodeOnLan(code, host);
				localStorage.setItem(PAIR_HOST_KEY, host);
				void secureSet(PAIR_HOST_KEY, host);
				connect(webLink, name.trim() || t("settings.myPhone"));
			} catch (err) {
				setLocalError(err instanceof Error ? err.message : String(err));
				haptic([20, 60, 20]);
			} finally {
				setPairBusy(false);
			}
		},
		[connect, name],
	);

	const runLink = useCallback(
		(rawLink: string, rawName: string): void => {
			const trimmed = rawLink.trim();
			if (!trimmed) {
				setLocalError(t("shell.pasteJoinLinkFirst"));
				return;
			}
			setLocalError(null);
			connect(trimmed, rawName.trim() || t("settings.myPhone"));
		},
		[connect],
	);

	const resolvePair = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		await runPair(pairCode, pairHost);
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		runLink(link, name);
	};

	// HarmonyOS renders the form as a native sheet; it pushes the values back
	// here. The handlers stay in a ref so the bridge registers once and still
	// closes over the latest connect/name.
	const sheetHandlers = useRef({ runPair, runLink });
	sheetHandlers.current = { runPair, runLink };
	useEffect(() => {
		if (!isHarmonyShell()) return;
		const w = window as unknown as Record<string, unknown>;
		w.__musepiPair = (code: string, host: string): void => {
			void sheetHandlers.current.runPair(code, host);
		};
		w.__musepiConnectLink = (url: string, deviceName: string): void => {
			sheetHandlers.current.runLink(url, deviceName);
		};
		return () => {
			delete w.__musepiPair;
			delete w.__musepiConnectLink;
		};
	}, []);

	const skip = (): void => {
		try {
			localStorage.setItem(SKIP_KEY, "1");
			localStorage.removeItem(LEGACY_SKIP_KEY);
		} catch {
			// storage unavailable
		}
		setSkipped(true);
	};

	const returnToGuide = (): void => {
		try {
			localStorage.removeItem(SKIP_KEY);
		} catch {
			// storage unavailable
		}
		setSkipped(false);
	};

	// Open the camera scanner (getUserMedia + jsQR). This avoids
	// @capacitor-mlkit, whose Google Play Services barcode module is
	// unavailable on 卓易通 / HarmonyOS-compat and non-GMS devices.
	const scanQr = (): void => {
		setLocalError(null);
		setScanning(true);
	};

	// Native connect page (HarmonyOS tab 0) asks this page to do the work:
	// resolve a saved computer's credential and connect — the E2E link never
	// mirrors into ArkTS, so the native list holds public metadata only.
	const connectHost = useCallback(
		(id: string): void => {
			const host = recent.find(item => item.id === id);
			if (host) connect(host.link, host.deviceName);
		},
		[recent, connect],
	);

	// The native Scan Kit result arrives here as a raw collab link; the page
	// connects like any other manual entry.
	const scanResult = useCallback(
		(raw: string): void => {
			const link = linkFromScannedCode(raw);
			if (!link) {
				setLocalError(t("settings.scanNotPairCode"));
				haptic([20, 60, 20]);
				return;
			}
			setLocalError(null);
			connect(link, name.trim() || t("settings.myPhone"));
		},
		[connect, name],
	);

	// The native connect page also hands every action back to this guide:
	// connecting to a saved computer, opening the QR scanner, and toggling
	// the skip state. Same ref pattern — registered once, latest closures,
	// torn down with the rest.
	const guideHandlers = useRef({ connectHost, skip, returnToGuide, scanQr, scanResult });
	guideHandlers.current = { connectHost, skip, returnToGuide, scanQr, scanResult };
	useEffect(() => {
		if (!isHarmonyShell()) return;
		const w = window as unknown as Record<string, unknown>;
		w.__musepiConnectHost = (id: string): void => {
			guideHandlers.current.connectHost(id);
		};
		w.__musepiSkipConnect = (): void => {
			guideHandlers.current.skip();
		};
		w.__musepiReturnToConnect = (): void => {
			guideHandlers.current.returnToGuide();
		};
		w.__musepiOpenScanner = (): void => {
			guideHandlers.current.scanQr();
		};
		w.__musepiScanResult = (link: string): void => {
			if (typeof link === "string" && link !== "") {
				guideHandlers.current.scanResult(link);
			}
		};
		return () => {
			delete w.__musepiConnectHost;
			delete w.__musepiSkipConnect;
			delete w.__musepiReturnToConnect;
			delete w.__musepiOpenScanner;
			delete w.__musepiScanResult;
		};
	}, []);

	// Android back key while scanning: close the scanner overlay instead of
	// exiting the app (scanner priority 95 — ConnectScreen has no Session
	// layers beneath, so nothing competes).
	useBackLayer(
		95,
		scanning,
		useCallback(() => {
			setScanning(false);
			return true;
		}, []),
	);

	const onScanResult = (value: string): void => {
		setScanning(false);
		connect(value, name.trim() || t("settings.myPhone"));
	};

	const onScanCancel = (): void => {
		setScanning(false);
	};

	const shown = localError ?? error;

	// Mirror the guide into the native connect page (HarmonyOS tab 0): the
	// shell paints its own ArkTS page over this one, so it needs the state
	// this card owns — skipped / offline / error. Error text is already
	// localized here and rendered verbatim by the native side.
	useEffect(() => {
		if (!isHarmonyShell()) return;
		window.harmonyNative?.setConnectInfo?.(JSON.stringify({ skipped, offline, error: shown ?? "" }));
	}, [skipped, offline, shown]);

	// Same mirror for the saved computers. Public metadata only — the rows
	// carry the same subtitle the web card shows (relay hint or the
	// computer's own name), and tapping one asks this page to connect.
	useEffect(() => {
		if (!isHarmonyShell()) return;
		const rows = recent.map(host => {
			const parts = addressParts(host.candidates[0]?.address ?? "");
			return { id: host.id, label: host.label, subtitle: parts.relay ? t("settings.hostPathRelay") : parts.host };
		});
		window.harmonyNative?.setHosts?.(JSON.stringify(rows));
	}, [recent]);

	// QR scanning is a web capability: getUserMedia + jsQR work in a phone
	// browser exactly as well as in a native WebView, so the entry follows
	// what the page can do rather than what surrounds it. A shell that denies
	// the camera still shows the row — the scanner reports the refusal and
	// points at the pair code, which is a better outcome than a missing entry.
	const canScan = canScanQr();

	const savedComputers = (
		<SavedComputers
			hosts={recent}
			onConnect={host => connect(host.link, host.deviceName)}
			onRemove={id => void forgetHost(id)}
		/>
	);
	const brand = (
		<div className="sh-connect-head">
			<div className="sh-lockup">
				{/* Brand S5 orb mark. The retired pi glyph used to be a separate
				 * span sitting OUTSIDE the gradient tile, which showed the old
				 * identity and read as a misaligned icon/background pair. */}
				<img className="sh-lockup-mark" src="./public/favicon.svg" alt="" aria-hidden="true" />
				<BlurText text={t("shell.musepiCollab")} />
			</div>
			<div className="sh-connect-preferences">
				<ThemeToggle />
				<AccentToggle />
				<LanguageToggle />
			</div>
		</div>
	);

	if (skipped) {
		return (
			<div className="sh-connect">
				<div className="sh-connect-card sh-connect-card--empty">
					<div className="sh-connect-matrix" aria-hidden="true">
						<DotMatrixMark text="MusePi" fontSize={96} gridGap={7} dotRadius={1.6} />
					</div>
					{brand}
					<div className="sh-connect-hero sh-connect-hero--compact">
						<h1>{t("settings.connectComputer")}</h1>
					</div>
					{savedComputers}
					<button type="button" className="sh-btn sh-btn-primary sh-connect-submit" onClick={returnToGuide}>
						{t("settings.connectComputer")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="sh-connect">
			<div className="sh-connect-card">
				<div className="sh-connect-matrix" aria-hidden="true">
					<DotMatrixMark text="MusePi" fontSize={96} gridGap={7} dotRadius={1.6} />
				</div>
				{brand}
				<section className="sh-connect-hero">
					<h1>{t("settings.mobileConnectTitle")}</h1>
				</section>
				{offline && (
					<div className="sh-connect-offline" role="status">
						{t("settings.offlineShowingCached.info")}
					</div>
				)}
				{savedComputers}
				<section className="sh-connect-methods" aria-label={t("settings.newConnection")}>
					{canScan && (
						<button
							type="button"
							className="sh-connect-method sh-connect-method--scan"
							style={{ "--order": 0 } as CSSProperties}
							onClick={scanQr}
						>
							<span className="sh-connect-method-ico" aria-hidden="true">
								<ScanLine size={20} />
							</span>
							<span className="sh-connect-method-body">
								<span className="sh-connect-method-title">{t("settings.scanQrCode")}</span>
							</span>
							<ArrowUpRight className="sh-connect-method-chev" size={17} aria-hidden="true" />
						</button>
					)}

					{/* Method 2: pair code (always available — pure ws). */}
					<div
						className={`sh-connect-method${openMethod === "pair" ? " sh-connect-method--open" : ""}`}
						style={{ "--order": 1 } as CSSProperties}
					>
						<button
							type="button"
							className="sh-connect-method"
							aria-expanded={openMethod === "pair"}
							onClick={() =>
								isHarmonyShell()
									? window.harmonyNative?.openPairSheet?.()
									: setOpenMethod(openMethod === "pair" ? null : "pair")
							}
						>
							<span className="sh-connect-method-ico" aria-hidden="true">
								<KeyRound size={18} />
							</span>
							<span className="sh-connect-method-body">
								<span className="sh-connect-method-title">{t("settings.pairCode")}</span>
							</span>
							<ChevronRight className="sh-connect-method-chev" size={17} aria-hidden="true" />
						</button>
						<div
							className="sh-connect-collapse"
							ref={pairBodyRef}
							aria-hidden={openMethod !== "pair"}
							inert={openMethod !== "pair"}
						>
							<form className="sh-connect-pair" onSubmit={e => void resolvePair(e)}>
								<div className="sh-connect-pair-row">
									{/* Shared-element morph ids (M1.10 §3.3 批次 B): the
									 * open method's input/button fly into the session
									 * composer's textarea/send on connect. Only one
									 * method body is open, so the visible pair wins the
									 * cache (collapsed bodies measure 0 and are skipped). */}
									<input
										className="sh-input sh-input-mono"
										type="text"
										inputMode="numeric"
										pattern="[0-9]{6}"
										maxLength={6}
										value={pairCode}
										onChange={e => setPairCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
										placeholder="123456"
										autoComplete="off"
										data-morph-id="composer-input"
									/>
									<input
										className="sh-input sh-input-mono"
										type="text"
										value={pairHost}
										onChange={e => setPairHost(e.target.value)}
										placeholder={t("settings.computerAddress")}
										autoComplete="off"
										spellCheck={false}
									/>
									<button
										className="sh-btn sh-btn-primary"
										type="submit"
										disabled={pairBusy || pairCode.length !== 6 || !pairHost.trim()}
										data-morph-id="composer-send"
									>
										{pairBusy ? t("settings.connecting2") : t("settings.pair")}
									</button>
								</div>
								<p className="sh-field-hint">{t("settings.noAddressShown.info")}</p>
							</form>
						</div>
					</div>

					{/* Method 3: paste link (power users). */}
					<div
						className={`sh-connect-method${openMethod === "link" ? " sh-connect-method--open" : ""}`}
						style={{ "--order": 2 } as CSSProperties}
					>
						<button
							type="button"
							className="sh-connect-method"
							aria-expanded={openMethod === "link"}
							onClick={() =>
								isHarmonyShell()
									? window.harmonyNative?.openLinkSheet?.()
									: setOpenMethod(openMethod === "link" ? null : "link")
							}
						>
							<span className="sh-connect-method-ico" aria-hidden="true">
								<Link2 size={18} />
							</span>
							<span className="sh-connect-method-body">
								<span className="sh-connect-method-title">{t("settings.pasteJoinLink")}</span>
							</span>
							<ChevronRight className="sh-connect-method-chev" size={17} aria-hidden="true" />
						</button>
						<div
							className="sh-connect-collapse"
							ref={linkBodyRef}
							aria-hidden={openMethod !== "link"}
							inert={openMethod !== "link"}
						>
							<form className="sh-connect-pair" onSubmit={submit}>
								<input
									className="sh-input sh-input-mono"
									type="text"
									value={link}
									onChange={e => setLink(e.target.value)}
									placeholder={t("shell.pasteCollabLinkAny")}
									spellCheck={false}
									autoComplete="off"
									data-morph-id="composer-input"
								/>
								<label className="sh-field">
									<span className="sh-field-label">{t("shell.displayName")}</span>
									<input
										className="sh-input"
										type="text"
										value={name}
										onChange={e => setName(e.target.value)}
										placeholder={t("settings.myPhone")}
										spellCheck={false}
										autoComplete="off"
										maxLength={32}
									/>
								</label>
								<button
									className="sh-btn sh-btn-primary sh-connect-submit"
									type="submit"
									data-morph-id="composer-send"
								>
									{t("settings.connect")}
								</button>
							</form>
						</div>
					</div>
				</section>

				{shown && (
					<div key={shown} className="sh-connect-error" role="alert">
						{/* Protocol errors arrive as English strings; the zh map carries
						 *  the same text as a key, so known ones translate and unknown
						 *  ones pass through unchanged. */}
						{tLoose(shown)}
					</div>
				)}
				<button type="button" className="sh-connect-skip" onClick={skip}>
					{t("settings.skipNow")}
				</button>
			</div>
			{scanning && <QrScanner onCancel={onScanCancel} onResult={onScanResult} />}
		</div>
	);
}
