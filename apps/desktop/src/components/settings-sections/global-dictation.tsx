/**
 * Settings → 语音 → 全局听写: the desktop-only system dictation switch and its
 * global accelerator. The two schema keys stay the source of truth
 * (`dictation.globalEnabled`, `dictation.globalShortcut`); this block exists
 * because the row needs a key-capture control, which the generic schema UI
 * cannot express.
 *
 * The main process polls these keys every ten seconds and (re)registers the
 * shortcut, so a change here takes effect without restarting the app.
 */
import { t } from "@musepi/client-core";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

const SHORTCUT_KEYS = new Set([
	"Space",
	"Enter",
	"Tab",
	"Backspace",
	"Delete",
	"Insert",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
]);

function acceleratorKey(key: string): string | null {
	if (key === "Escape") return null;
	if (/^F\d{1,2}$/.test(key)) return key;
	if (SHORTCUT_KEYS.has(key)) return key;
	if (key.length === 1) return key.toUpperCase();
	return null;
}

export function GlobalDictationSettings({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [enabled, setEnabled] = useState(false);
	const [shortcut, setShortcut] = useState("CommandOrControl+Alt+Space");
	const [capturing, setCapturing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [registered, setRegistered] = useState<boolean | null>(null);

	const load = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<Record<string, unknown> | null>("settings.get", {
				keys: ["dictation.globalEnabled", "dictation.globalShortcut"],
			})
			.then(values => {
				setEnabled(values?.["dictation.globalEnabled"] === true);
				const saved = values?.["dictation.globalShortcut"];
				if (typeof saved === "string" && saved.trim()) setShortcut(saved.trim());
			})
			.catch(() => {});
	}, [rpc]);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		if (!enabled) {
			setRegistered(null);
			return;
		}
		let alive = true;
		const read = (): void => {
			void (
				window as unknown as { electronAPI?: { dictationStatus?: () => Promise<{ registered: boolean | null }> } }
			).electronAPI
				?.dictationStatus?.()
				.then(status => {
					if (alive) setRegistered(status?.registered ?? null);
				})
				.catch(() => {});
		};
		read();
		const timer = window.setInterval(read, 2000);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [enabled, shortcut]);

	const commit = useCallback(
		(key: string, value: unknown): void => {
			if (!rpc) return;
			setError(null);
			void rpc.request("settings.set", { key, value }).catch(err => {
				setError(err instanceof Error ? err.message : String(err));
			});
		},
		[rpc],
	);

	const toggle = (): void => {
		const next = !enabled;
		setEnabled(next);
		commit("dictation.globalEnabled", next);
	};

	const onShortcutKey = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			setCapturing(false);
			return;
		}
		const key = acceleratorKey(event.key);
		if (!key) return;
		const modifiers: string[] = [];
		if (event.ctrlKey || event.metaKey) modifiers.push("CommandOrControl");
		if (event.altKey) modifiers.push("Alt");
		if (event.shiftKey) modifiers.push("Shift");
		// A bare letter would take that key from every application.
		if (modifiers.length === 0) return;
		const next = [...modifiers, key].join("+");
		setShortcut(next);
		setCapturing(false);
		commit("dictation.globalShortcut", next);
	};

	return (
		<div className="gui-settings-section">
			<div className="gui-settings-row">
				<div className="min-w-0 flex-1">
					<div className="gui-settings-row-label">{t("settings.globalDictationTitle")}</div>
					<div className="gui-settings-row-desc">{t("settings.globalDictationHint")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={enabled}
					aria-label={t("settings.globalDictationEnable")}
					className={`gui-toggle${enabled ? " gui-toggle--on" : ""}`}
					onClick={toggle}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>
			<div className="gui-settings-row">
				<div className="min-w-0 flex-1">
					<div className="gui-settings-row-label">{t("settings.globalDictationShortcutLabel")}</div>
					<div className="gui-settings-row-desc">{t("settings.globalDictationShortcutNote")}</div>
				</div>
				<button
					type="button"
					className={`gui-dictation-shortcut${capturing ? " gui-dictation-shortcut--capturing" : ""}`}
					onClick={() => setCapturing(true)}
					onBlur={() => setCapturing(false)}
					onKeyDown={onShortcutKey}
					aria-label={t("settings.globalDictationShortcutLabel")}
				>
					{capturing ? t("settings.globalDictationPressKeys") : shortcutDisplay(shortcut)}
				</button>
			</div>
			{enabled && registered === false && (
				<div className="gui-settings-row-desc gui-settings-row-desc--warn">
					{t("settings.globalDictationShortcutUnavailable")}
				</div>
			)}
			{error && <div className="gui-settings-row-desc">{error}</div>}
		</div>
	);
}

function shortcutDisplay(accelerator: string): string {
	const mac = navigator.platform.toLowerCase().includes("mac");
	return accelerator
		.replace("CommandOrControl", mac ? "⌘" : "Ctrl")
		.replace("Shift", mac ? "⇧" : "Shift")
		.replace("Alt", mac ? "⌥" : "Alt")
		.split("+")
		.join(mac ? "" : " + ");
}
