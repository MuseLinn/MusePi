import { t } from "@musepi/client-core";
import { AppWindow, Check, ChevronDown, Code, Folder, RefreshCw, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listOpenInApps, type OpenInApp, openWith } from "../lib/electron";
import { MenuPopup } from "./MenuPopup";

/** Shared with the top bar's open-in capsule: picking an app in either place
 *  makes the other one show the same icon next time. */
const PREFERRED_APP_KEY = "musepi-gui-openin-app";

/** Ids whose real icon the shell often cannot extract (WindowsApps aliases,
 *  PATH shims) — a built-in glyph keeps the menu scannable. */
const FALLBACK_GLYPH: Record<string, typeof Folder> = {
	explorer: Folder,
	nautilus: Folder,
	dolphin: Folder,
	terminal: Terminal,
	"gnome-terminal": Terminal,
	konsole: Terminal,
	iterm: Terminal,
	warp: Terminal,
	ghostty: Terminal,
	vscode: Code,
	cursor: Code,
	zed: Code,
	intellij: Code,
	pycharm: Code,
	goland: Code,
	rider: Code,
	clion: Code,
	sublime: Code,
	kate: Code,
	bbedit: Code,
	gedit: Code,
};

/** One scan per app session; opening several files should not respawn the
 *  shell's app probe every time the preview remounts. */
let cachedApps: OpenInApp[] | null = null;
let appsInFlight: Promise<OpenInApp[]> | null = null;

function loadApps(): Promise<OpenInApp[]> {
	if (cachedApps) return Promise.resolve(cachedApps);
	appsInFlight ??= listOpenInApps().then(apps => {
		cachedApps = apps;
		appsInFlight = null;
		return apps;
	});
	return appsInFlight;
}

function readPreferredApp(): string | null {
	try {
		return localStorage.getItem(PREFERRED_APP_KEY);
	} catch {
		return null;
	}
}

function rememberPreferredApp(id: string | null): void {
	try {
		if (id) localStorage.setItem(PREFERRED_APP_KEY, id);
		else localStorage.removeItem(PREFERRED_APP_KEY);
	} catch {
		// private mode / storage disabled — the icon just falls back next time
	}
}

function openInLabel(app: OpenInApp): string {
	const key = `open in ${app.id}` as unknown as Parameters<typeof t>[0];
	return t(key) === key ? app.label : t(key);
}

function AppIcon({ app }: { app: OpenInApp | null }): ReactNode {
	if (app?.iconDataUrl) return <img src={app.iconDataUrl} alt="" draggable={false} />;
	if (app) {
		const Glyph = FALLBACK_GLYPH[app.id];
		if (Glyph) return <Glyph size={12} strokeWidth={1.8} aria-hidden="true" />;
		return app.label.trim().slice(0, 1).toUpperCase();
	}
	return <AppWindow size={13} strokeWidth={1.8} aria-hidden="true" />;
}

/** Per-file open-with picker: the leading pill opens with the remembered
 *  app (or the OS default when none is known) and the chevron lists every
 *  detected app with its real icon. */
export function FileOpenWith({ path }: { path: string }): ReactNode {
	const anchor = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [apps, setApps] = useState<OpenInApp[]>(() => cachedApps ?? []);
	const [preferredId, setPreferredId] = useState<string | null>(readPreferredApp);
	const [scanning, setScanning] = useState(cachedApps === null);

	const scan = useCallback((): void => {
		setScanning(true);
		void loadApps()
			.then(list => setApps(list))
			.finally(() => setScanning(false));
	}, []);

	useEffect(() => {
		scan();
	}, [scan]);

	const preferred = apps.find(app => app.id === preferredId) ?? null;
	const launch = (app: OpenInApp | null): void => {
		setOpen(false);
		setPreferredId(app?.id ?? null);
		rememberPreferredApp(app?.id ?? null);
		void openWith(app?.appName ?? "", path);
	};
	const title = t("settings.openWith");

	return (
		<>
			<span className="gui-openin-capsule">
				<button
					type="button"
					className={`gui-openin-main${scanning ? " gui-openin-main--scanning" : ""}`}
					title={title}
					aria-label={title}
					onClick={() => launch(preferred)}
				>
					<span className="gui-openin-app-icon">
						<AppIcon app={preferred} />
					</span>
				</button>
				<button
					ref={anchor}
					type="button"
					className="gui-openin-more"
					title={t("settings.chooseOpenApp")}
					aria-label={t("settings.chooseOpenApp")}
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
				>
					<ChevronDown size={12} />
				</button>
			</span>
			<MenuPopup
				open={open}
				className="gui-openin-menu gui-file-open-with"
				anchor={anchor.current}
				align="right"
				onOpenChange={setOpen}
			>
				{apps.map(app => {
					const active = preferred?.id === app.id;
					return (
						<button
							key={app.id}
							type="button"
							className={`gui-view-opt${active ? " gui-view-opt--active" : ""}`}
							onClick={() => launch(app)}
						>
							<span className="gui-openin-app-icon">
								<AppIcon app={app} />
							</span>
							<span>{openInLabel(app)}</span>
							{active && <Check size={12} className="gui-file-open-with-check" aria-hidden="true" />}
						</button>
					);
				})}
				{apps.length === 0 && <div className="gui-file-open-with-empty">{t("general.noApps")}</div>}
				<div className="gui-file-open-with-divider" />
				<button type="button" className="gui-view-opt" onClick={() => launch(null)}>
					<span className="gui-openin-app-icon">
						<AppIcon app={null} />
					</span>
					<span>{t("settings.openDefaultApp")}</span>
				</button>
				<button type="button" className="gui-view-opt" onClick={scan}>
					<RefreshCw size={12} aria-hidden="true" />
					<span>{t("general.refreshApps")}</span>
				</button>
			</MenuPopup>
		</>
	);
}
