import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { isNativeShell } from "../../lib/capacitor";
import { useLocale } from "../../i18n/use-locale.js";
import { type Connection, loadConnections, rememberConnection, removeConnection } from "../../lib/connections";
import { haptic } from "../../lib/haptics";
import { secureGet, secureSet } from "../../lib/secure-store";
import { useCollapseHeight } from "../../lib/use-collapse";
import { AccentToggle } from "./AccentToggle";
import { LanguageToggle } from "./LanguageToggle";
import { ThemeToggle } from "./ThemeToggle";

export interface ConnectScreenProps {
	defaultName: string;
	/** Deep-link fragment (a full collab link) pre-fills the input so a failed auto-connect still shows what to join. */
	defaultLink?: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

const RECENT_KEY = "musepi.collab.recent";
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
			reject(new Error(t("pair code timed out — check the address")));
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
				else reject(new Error(msg.error?.message ?? t("invalid or expired pair code")));
			} catch {
				reject(new Error(t("invalid pair response")));
			}
		};
		ws.onerror = () => {
			clearTimeout(timer);
			reject(new Error(t("cannot reach the computer — same Wi-Fi?")));
		};
	});
}

/**
 * Guided connect screen — the mobile/guest onboarding. Three ways to reach
 * a desktop daemon on the same network:
 *   1. Scan the desktop's QR (Capacitor barcode, lazily loaded plugin)
 *   2. Pair code + computer address (pure ws — always available)
 *   3. Paste a /collab link (power users)
 * A skip affordance dismisses the guide into a lightweight empty state; the
 * guide reopens from there (and on next launch unless skipped persists).
 */
export function ConnectScreen({ defaultName, defaultLink, error, onConnect }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState(defaultLink ?? "");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);
	const [recent, setRecent] = useState<Connection[]>(loadConnections);
	const [pairCode, setPairCode] = useState("");
	const [pairHost, setPairHost] = useState("");
	const [pairBusy, setPairBusy] = useState(false);
	const [openMethod, setOpenMethod] = useState<"pair" | "link" | null>(null);
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
	// Subscribe this card to locale changes: every label below flows through
	// t(), which reads the store non-reactively — without a useLocale()
	// subscriber here, switching languages only re-renders the toggle button
	// and the rest of the guide keeps the old language until remount.
	useLocale();
	useCollapseHeight(openMethod === "link", linkBodyRef);

	// Hydrate secure-stored state (recent connections, remembered pair host)
	// after mount; localStorage mirrors render immediately, secure values win.
	useEffect(() => {
		let alive = true;
		void (async () => {
			const rawRecent = await secureGet(RECENT_KEY);
			if (alive && rawRecent) {
				try {
					const parsed: unknown = JSON.parse(rawRecent);
					if (Array.isArray(parsed)) setRecent(parsed as Connection[]);
				} catch {
					// corrupt mirror — keep current list
				}
			}
			const host = await secureGet(PAIR_HOST_KEY);
			if (alive && host) setPairHost(host);
		})();
		return () => {
			alive = false;
		};
	}, []);

	const connect = (target: string, who: string): void => {
		rememberConnection(target, who);
		setRecent(loadConnections());
		onConnect(target, who);
		haptic(12);
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError(t("paste a join link first"));
			return;
		}
		setLocalError(null);
		connect(trimmed, name.trim() || t("guest"));
	};

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

	// Scan QR — lazily imports the mlkit plugin so the browser bundle stays
	// lean and non-native pages never touch Capacitor. Runtime camera consent
	// is requested here (the manifest only declares the permission).
	const scanQr = async (): Promise<void> => {
		setLocalError(null);
		try {
			const { BarcodeScanner } = await import("@capacitor-mlkit/barcode-scanning");
			const { camera } = await BarcodeScanner.requestPermissions();
			if (camera !== "granted") {
				setLocalError(t("camera permission denied — use the pair code instead"));
				return;
			}
			const result = await BarcodeScanner.scan();
			const value = result.barcodes?.[0]?.displayValue?.trim();
			if (value) connect(value, name.trim() || t("guest"));
		} catch {
			setLocalError(t("scan failed — use the pair code instead"));
			haptic([20, 60, 20]);
		}
	};

	const resolvePair = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		const code = pairCode.trim();
		const host = pairHost.trim();
		if (!code || !host) {
			setLocalError(t("enter the pair code and computer address"));
			return;
		}
		setPairBusy(true);
		setLocalError(null);
		try {
			const webLink = await resolvePairCodeOnLan(code, host);
			localStorage.setItem(PAIR_HOST_KEY, host);
			void secureSet(PAIR_HOST_KEY, host);
			connect(webLink, name.trim() || t("guest"));
		} catch (err) {
			setLocalError(err instanceof Error ? err.message : String(err));
			haptic([20, 60, 20]);
		} finally {
			setPairBusy(false);
		}
	};

	const shown = localError ?? error;
	const native = isNativeShell();

	// Skipped empty state: light brand + return-to-guide.
	if (skipped) {
		return (
			<div className="sh-connect">
				<div className="sh-connect-card sh-connect-card--empty">
					<div className="sh-connect-head">
						<div className="sh-lockup">
							<span className="sh-lockup-mark" aria-hidden="true" />
							<span className="sh-lockup-pi">π</span> {t("musepi collab")}
						</div>
						<ThemeToggle />
						<AccentToggle />
						<LanguageToggle />
					</div>
					<div className="sh-connect-sub">{t("live agent session, in your browser")}</div>
					<p className="sh-connect-empty-text">
						{t("not connected yet — connect to a computer to view sessions")}
					</p>
					{recent.length > 0 && (
						<div className="sh-connect-recent">
							<span className="sh-field-label">{t("recent connections")}</span>
							{recent.map(r => (
								<div key={r.link} className="sh-connect-recent-item">
									<button
										type="button"
										className="sh-connect-recent-main"
										title={r.link}
										onClick={() => connect(r.link, r.name)}
									>
										<span className="sh-connect-recent-name">{r.label || r.name}</span>
										<span className="sh-connect-recent-link">{r.link}</span>
									</button>
									<button
										type="button"
										className="sh-btn sh-btn-icon sh-connect-recent-rm"
										title={t("remove")}
										onClick={() => {
											removeConnection(r.link);
											setRecent(loadConnections());
										}}
									>
										✕
									</button>
								</div>
							))}
						</div>
					)}
					<button type="button" className="sh-btn sh-btn-primary sh-connect-submit" onClick={returnToGuide}>
						{t("connect to a computer")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="sh-connect">
			<div className="sh-connect-card">
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span className="sh-lockup-pi">π</span> {t("musepi collab")}
					</div>
					<ThemeToggle />
					<AccentToggle />
					<LanguageToggle />
				</div>
				<div className="sh-connect-sub">{t("connect to a computer on your network")}</div>
				{recent.length > 0 && (
					<div className="sh-connect-recent">
						<span className="sh-field-label">{t("recent connections")}</span>
						{recent.map(r => (
							<div key={r.link} className="sh-connect-recent-item">
								<button
									type="button"
									className="sh-connect-recent-main"
									title={r.link}
									onClick={() => connect(r.link, r.name)}
								>
									<span className="sh-connect-recent-name">{r.label || r.name}</span>
									<span className="sh-connect-recent-link">{r.link}</span>
								</button>
								<button
									type="button"
									className="sh-btn sh-btn-icon sh-connect-recent-rm"
									title={t("remove")}
									onClick={() => {
										removeConnection(r.link);
										setRecent(loadConnections());
									}}
								>
									✕
								</button>
							</div>
						))}
					</div>
				)}

				{/* Method 1: scan QR (native shell only). */}
				{native && (
					<button
						type="button"
						className="sh-connect-method sh-connect-method--scan"
						style={{ "--order": 0 } as CSSProperties}
						onClick={() => void scanQr()}
					>
						<span className="sh-connect-method-ico">▣</span>
						<span className="sh-connect-method-body">
							<span className="sh-connect-method-title">{t("scan the QR code")}</span>
							<span className="sh-connect-method-desc">{t("scan the desktop share QR with your camera")}</span>
						</span>
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
						onClick={() => setOpenMethod(openMethod === "pair" ? null : "pair")}
					>
						<span className="sh-connect-method-ico">⌘</span>
						<span className="sh-connect-method-body">
							<span className="sh-connect-method-title">{t("pair code")}</span>
							<span className="sh-connect-method-desc">
								{t("enter the 6-digit code from the desktop share panel")}
							</span>
						</span>
						<span className="sh-connect-method-chev" aria-hidden="true">
							›
						</span>
					</button>
					<div
						className="sh-connect-collapse"
						ref={pairBodyRef}
						aria-hidden={openMethod !== "pair"}
						inert={openMethod !== "pair"}
					>
						<form className="sh-connect-pair" onSubmit={e => void resolvePair(e)}>
							<div className="sh-connect-pair-row">
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
								/>
								<input
									className="sh-input sh-input-mono"
									type="text"
									value={pairHost}
									onChange={e => setPairHost(e.target.value)}
									placeholder={t("computer address (192.168.x.x)")}
									autoComplete="off"
									spellCheck={false}
								/>
								<button
									className="sh-btn sh-btn-primary"
									type="submit"
									disabled={pairBusy || !pairCode.trim() || !pairHost.trim()}
								>
									{pairBusy ? t("connecting…") : t("pair")}
								</button>
							</div>
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
						onClick={() => setOpenMethod(openMethod === "link" ? null : "link")}
					>
						<span className="sh-connect-method-ico">🔗</span>
						<span className="sh-connect-method-body">
							<span className="sh-connect-method-title">{t("paste a join link")}</span>
							<span className="sh-connect-method-desc">{t("ws://host:port/r/room.key")}</span>
						</span>
						<span className="sh-connect-method-chev" aria-hidden="true">
							›
						</span>
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
								placeholder={t("paste a /collab link from any musepi session")}
								spellCheck={false}
								autoComplete="off"
							/>
							<label className="sh-field">
								<span className="sh-field-label">{t("display name")}</span>
								<input
									className="sh-input"
									type="text"
									value={name}
									onChange={e => setName(e.target.value)}
									placeholder={t("guest")}
									spellCheck={false}
									autoComplete="off"
									maxLength={32}
								/>
							</label>
							<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
								{t("Connect")}
							</button>
						</form>
					</div>
				</div>

				{shown && (
					<div key={shown} className="sh-connect-error" role="alert">
						{shown}
					</div>
				)}
				<button type="button" className="sh-connect-skip" onClick={skip}>
					{t("skip for now")}
				</button>
			</div>
		</div>
	);
}
