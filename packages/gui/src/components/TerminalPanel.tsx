import { Terminal } from "@xterm/xterm";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { t, useSystemTheme } from "@musepi/desktop-web";
import type { RpcClient, StreamEvent } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";

/**
 * Multi-tab integrated terminal (ZCode/openchamber style). Each tab owns
 * one daemon pty (terminal.open id); the daemon already multiplexes, so
 * tabs are just independent xterm instances.
 */
interface TabEntry {
	key: number;
	label: string;
}

/** xterm palette matched to the app's light/dark scheme (CSS var strings
 * don't resolve inside xterm's canvas, so pick concrete tokens). */
function xtermTheme(scheme: "light" | "dark"): {
	background: string;
	foreground: string;
	cursor: string;
	selectionBackground: string;
} {
	return {
		// Fully transparent canvas — the pane/dock background shows through
		// (the string "transparent" parses to black in xterm).
		background: "rgba(0,0,0,0)",
		foreground: scheme === "dark" ? "#d4d4d8" : "#3f3f46",
		cursor: scheme === "dark" ? "#8b7cf6" : "#5b3df5",
		selectionBackground: "rgba(124, 92, 255, 0.3)",
	};
}

function baseName(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || "home";
}

function TerminalTab({
	rpc,
	cwd,
	active,
	onLabel,
}: {
	rpc: RpcClient;
	cwd: string;
	active: boolean;
	onLabel(label: string): void;
}): ReactNode {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termIdRef = useRef<string | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const scheme = useSystemTheme();
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const term = new Terminal({
			fontFamily: "var(--font-mono), Menlo, monospace",
			// openchamber parity: terminal font size is user-configurable
			// (settings → 外观), default 13px.
			fontSize: Number(localStorage.getItem("musepi-gui-terminal-font") ?? 13),
			scrollback: 2000,
			cursorBlink: true,
		});
		termRef.current = term;
		term.open(host);

		let disposed = false;
		const unsub = rpc.addEventListener((event: StreamEvent) => {
			const p = event.payload as { id?: string; data?: string; code?: number; message?: string } | null;
			if (!p?.id || p.id !== termIdRef.current || disposed) return;
			if (event.kind === "terminal-output" && typeof p.data === "string") {
				term.write(p.data);
			} else if (event.kind === "terminal-exit") {
				term.write(`\r\n\x1b[90m[process exited ${p.code ?? 0}]\x1b[0m\r\n`);
			} else if (event.kind === "terminal-error") {
				setError(p.message ?? "terminal error");
			}
		});

		const onData = (data: string): void => {
			const id = termIdRef.current;
			if (!id) return;
			void rpc.request("terminal.input", { id, data }).catch(() => {});
		};
		term.onData(onData);

		void rpc
			.request<{ id: string }>("terminal.open", { cwd, cols: term.cols, rows: term.rows })
			.then((res: { id: string }) => {
				if (disposed) {
					void rpc.request("terminal.close", { id: res.id }).catch(() => {});
					return;
				}
				termIdRef.current = res.id;
			})
			.catch(err => setError(err instanceof Error ? err.message : String(err)));

		const onResize = (): void => {
			const id = termIdRef.current;
			if (!id) return;
			void rpc.request("terminal.resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
		};
		term.onResize(onResize);
		// The pane/dock width is user-draggable — refit the xterm grid on
		// host size changes. Hidden tabs report 0×0, so skip those (the
		// observer fires again when the tab becomes visible). term.resize()
		// itself fires xterm's onResize, which sends the RPC — no duplicate
		// call needed here.
		let ro: ResizeObserver | null = null;
		if (typeof ResizeObserver !== "undefined") {
			ro = new ResizeObserver(() => {
				if (!host.offsetParent) return;
				const dims = host.getBoundingClientRect();
				// Cap the columns so a transient oversized host width (layout not
				// settled at mount) can't compound into a runaway-wide xterm.
				term.resize(
					Math.min(400, Math.max(20, Math.floor(dims.width / 8))),
					Math.max(5, Math.floor(dims.height / 16)),
				);
			});
			ro.observe(host);
		}

		return () => {
			disposed = true;
			unsub();
			ro?.disconnect();
			const id = termIdRef.current;
			if (id) void rpc.request("terminal.close", { id }).catch(() => {});
			termIdRef.current = null;
			termRef.current = null;
			term.dispose();
		};
	}, [rpc, cwd]);

	// Light/dark scheme switch → retint the xterm palette in place.
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		term.options.theme = xtermTheme(scheme);
		term.refresh(0, term.rows - 1);
	}, [scheme]);

	// External command channel (e.g. the header dev-server button): the
	// ACTIVE tab executes whatever is broadcast on musepi-gui-terminal-cmd.
	// The header's project-actions stop button broadcasts
	// musepi-gui-terminal-stop, which sends Ctrl+C to the active tab
	// (openchamber projectActions.stopAction parity). paste() routes
	// through term.onData, so the bytes reach the daemon pty — write()
	// would only paint them on the display.
	useEffect(() => {
		const onCmd = (e: Event): void => {
			if (!active) return;
			const cmd = (e as CustomEvent<string>).detail;
			if (typeof cmd !== "string" || !cmd) return;
			termRef.current?.paste(`${cmd}\r`);
		};
		const onStop = (): void => {
			if (!active) return;
			termRef.current?.paste("\x03");
		};
		window.addEventListener("musepi-gui-terminal-cmd", onCmd);
		window.addEventListener("musepi-gui-terminal-stop", onStop);
		return () => {
			window.removeEventListener("musepi-gui-terminal-cmd", onCmd);
			window.removeEventListener("musepi-gui-terminal-stop", onStop);
		};
	}, [active]);

	// Tab label follows the cwd basename (active tab included). onLabel is a
	// fresh inline closure every parent render, so read it through a ref and
	// only react to cwd changes — otherwise the effect would re-fire each
	// render and setTabs would re-render the panel forever.
	const onLabelRef = useRef(onLabel);
	useEffect(() => {
		onLabelRef.current = onLabel;
	}, [onLabel]);
	useEffect(() => {
		if (cwd) onLabelRef.current(`${baseName(cwd)}`);
	}, [cwd]);

	if (error) {
		return (
			<div className="gui-tool-placeholder">
				<Icon name="terminal-box" className="h-6 w-6" />
				<span>{error}</span>
				<span className="text-[12px] text-[var(--color-text-faint)]">{t("tool needs a daemon backend")}</span>
			</div>
		);
	}
	return <div ref={hostRef} className="gui-terminal-host" style={{ display: active ? "block" : "none" }} />;
}

export function TerminalPanel({
	rpc,
	cwd,
	onAllClosed,
}: {
	rpc: RpcClient;
	cwd: string;
	/** Last tab closed → fold the whole dock (the panel stays mounted, so
	 *  a fresh tab is re-seeded and survives the toggle). */
	onAllClosed?: () => void;
}): ReactNode {
	const [tabs, setTabs] = useState<TabEntry[]>([{ key: 0, label: baseName(cwd) || "shell" }]);
	const [active, setActive] = useState(0);
	const seq = useRef(1);
	// Live tab count for the "last tab" check (state closures go stale on
	// rapid successive closes — the ref never does).
	const tabCountRef = useRef(1);
	tabCountRef.current = tabs.length;

	const closeTab = (key: number): void => {
		if (tabCountRef.current <= 1) {
			// Closing the last tab folds the dock; a fresh tab is seeded so
			// reopening the panel has a ready terminal.
			onAllClosed?.();
		}
		setTabs(ts => {
			const next = ts.filter(x => x.key !== key);
			if (next.length === 0) next.push({ key: seq.current++, label: baseName(cwd) || "shell" });
			return next;
		});
		setActive(a => {
			const idx = tabs.findIndex(x => x.key === key);
			if (idx === -1) return a;
			const remaining = tabs.filter(x => x.key !== key);
			const target = Math.min(Math.max(idx, 0), remaining.length - 1);
			return remaining[target]?.key ?? 0;
		});
	};

	return (
		<div className="gui-terminal flex h-full min-h-0 flex-col">
			<div className="gui-terminal-tabs flex h-9 flex-shrink-0 items-center gap-1 px-2">
				{tabs.map(tab => (
					<div
						key={tab.key}
						role="tab"
						aria-selected={tab.key === active}
						className={`gui-terminal-tab group flex h-[26px] max-w-[180px] cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12px]${
							tab.key === active ? " gui-terminal-tab--active" : ""
						}`}
						title={tab.label}
						onClick={() => setActive(tab.key)}
						onAuxClick={e => {
							// Middle-click closes the tab (openchamber sortable-tabs-strip parity).
							if (e.button === 1) {
								e.preventDefault();
								closeTab(tab.key);
							}
						}}
					>
						<Icon name="terminal-box" className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{tab.label}</span>
						<button
							type="button"
							aria-label={t("close")}
							title={t("close")}
							className={`gui-term-close ml-0.5 rounded p-0.5 text-[var(--color-text-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]${
								tab.key === active ? " block" : " hidden group-hover:block"
							}`}
							onClick={e => {
								e.stopPropagation();
								closeTab(tab.key);
							}}
						>
							<Icon name="close" className="h-3 w-3" />
						</button>
					</div>
				))}
				<button
					type="button"
					aria-label={t("new tab")}
					title={t("new tab")}
					className="gui-terminal-new ml-0.5 flex h-[26px] w-6 items-center justify-center rounded-full text-[var(--color-text-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-text)]"
					onClick={() => {
						const key = seq.current++;
						setTabs(ts => [...ts, { key, label: baseName(cwd) || "shell" }]);
						setActive(key);
					}}
				>
					<Icon name="add" className="h-3.5 w-3.5" />
				</button>
				<div className="ml-auto" />
			</div>
			<div className="gui-terminal-body min-h-0 flex-1 px-2.5 pb-2.5 pt-1">
				{tabs.map(tab => (
					<TerminalTab
						key={tab.key}
						rpc={rpc}
						cwd={cwd}
						active={tab.key === active}
						onLabel={label => setTabs(ts => ts.map(x => (x.key === tab.key ? { ...x, label } : x)))}
					/>
				))}
			</div>
		</div>
	);
}
