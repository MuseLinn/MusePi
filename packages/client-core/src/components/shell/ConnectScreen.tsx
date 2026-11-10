import { ArrowUpRight, ChevronRight, KeyRound, Link2, Monitor, ScanLine, X } from "lucide-react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/use-locale.js";
import { useBackLayer } from "../../lib/back-stack";
import { isHarmonyShell, isMobileShell } from "../../lib/capacitor";
import { haptic } from "../../lib/haptics";
import { loadResolvedHosts, type ResolvedHost, removeHost } from "../../lib/hosts";
import { secureGet, secureSet } from "../../lib/secure-store";
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
const SKIP_KEY = "omp-collab-skipped";
/** Pair endpoint port (daemon server.ts PAIR_PORT). */
const PAIR_PORT = 8301;

/** Resolve a 6-digit pair code against the daemon's LAN pair endpoint
 *  (pair.resolve) to obtain the full collab webLink. */
function resolvePairCodeOnLan(code: string, host: string): Promise<string> {
	const origin = host.includes(":") ? host : `${host}:${PAIR_PORT}`;
	const url = `ws://${origin}`;
	return new Promise<string>((resolve, reject) => {
		const ws = new WebSocket(url);
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
				{hosts.map((host, index) => (
					<div
						key={host.id}
						className={`sh-connect-recent-item${index === 0 ? " sh-connect-recent-item--primary" : ""}`}
					>
						<button
							type="button"
							className="sh-connect-recent-main"
							title={host.candidates[0]?.address}
							onClick={() => onConnect(host)}
						>
							<span className="sh-connect-recent-icon" aria-hidden="true">
								<Monitor size={18} />
							</span>
							<span className="sh-connect-recent-copy">
								<span className="sh-connect-recent-name">{host.label}</span>
								<span className="sh-connect-recent-link">{host.candidates[0]?.address}</span>
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
				))}
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
			return localStorage.getItem(SKIP_KEY) === "1";
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
	// QR scanning needs a camera-bearing native WebView. Both Capacitor
	// (Android) and the HarmonyOS ArkWeb shell qualify — the latter grants
	// getUserMedia through Web.onPermissionRequest + the CAMERA user grant.
	const native = isMobileShell();

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
					{native && (
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
										onChange={e => setPairCode(e.target.value)}
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
										disabled={pairBusy || !pairCode.trim() || !pairHost.trim()}
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
						{shown}
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
