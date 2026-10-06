import { t } from "@musepi/client-core";
import type { DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient, StreamEvent } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";

/**
 * Install a plugin from a spec: a package name, a git source, a tarball, or an
 * absolute local path.
 *
 * The install runs on the daemon through `plugins.install`, which answers
 * immediately with an `installId` and then reports through two events — this
 * dialog never holds an RPC open across the package manager's run, so a slow
 * install cannot hit the 15s client timeout and the person can leave at any
 * moment without losing the run's identity.
 *
 * The four phases are the same ones the daemon machine reports (`inspecting`,
 * `installing`, then a terminal state), and the terminal state is where the
 * capability report lands: an install can succeed and still leave a plugin that
 * cannot load on this host, and saying so here is the difference between a
 * person learning it now and learning it from a silent failure later.
 */

type InstallPhase = "idle" | "inspecting" | "installing" | "done" | "failed" | "cancelled";

interface PluginCapabilityReport {
	verdict: "runnable" | "partial" | "incompatible";
	missing: string[];
	unhostedSlots: string[];
	summary: string;
}

interface InstallView {
	installId: string;
	spec: string;
	state: InstallPhase;
	kind?: string;
	message?: string;
	name?: string;
	version?: string;
	capability?: PluginCapabilityReport;
}

interface OutputLine {
	stream: "stdout" | "stderr";
	text: string;
}

const MAX_OUTPUT_LINES = 400;

/**
 * Archive shapes a drop may carry. A folder is always accepted (it has no
 * extension to match), so the pattern only judges files: these are the archive
 * extensions bun can install from, and a trailing Windows path separator is
 * allowed so a dropped folder matches too.
 */
const DROP_ACCEPTED = /(?:\.(?:tgz|tar\.gz|tar|zip)|[\\/])$/i;

export function PluginInstallDialog({
	rpc,
	open,
	onClose,
	onInstalled,
}: {
	rpc: RpcClient | null;
	open: boolean;
	onClose(): void;
	/** Called after a successful install so the list can re-read. */
	onInstalled(): void;
}): ReactNode {
	const [spec, setSpec] = useState("");
	const [view, setView] = useState<InstallView | null>(null);
	const [lines, setLines] = useState<OutputLine[]>([]);
	const [error, setError] = useState<string | null>(null);
	// Drag-and-drop highlight. Declared with the other hooks rather than next to
	// the effect that consumes it: every hook belongs to one block above the
	// first early return, so adding a conditional return later cannot split the
	// hook order across renders.
	const [dragging, setDragging] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const logRef = useRef<HTMLDivElement | null>(null);

	const busy = view?.state === "inspecting" || view?.state === "installing";

	// The daemon reports every install it knows about, including ones started
	// elsewhere. Filtering on the id this dialog owns is what keeps another
	// window's install from overwriting this transcript.
	const activeId = view?.installId ?? null;
	useEffect(() => {
		if (!rpc || !activeId) return;
		const unlistenState = rpc.addEventListener((event: StreamEvent) => {
			const payload = event.payload as (InstallView & { type?: string }) | undefined;
			if (payload?.type !== "plugins.install.state" || payload.installId !== activeId) return;
			setView(current => (current ? { ...current, ...payload } : current));
		});
		const unlistenOutput = rpc.addEventListener((event: StreamEvent) => {
			const payload = event.payload as
				| { type?: string; installId?: string; stream?: "stdout" | "stderr"; text?: string }
				| undefined;
			if (payload?.type !== "plugins.install.output" || payload.installId !== activeId) return;
			if (payload.stream === undefined || payload.text === undefined) return;
			setLines(current => {
				const next = [...current, { stream: payload.stream as "stdout" | "stderr", text: payload.text as string }];
				return next.length > MAX_OUTPUT_LINES ? next.slice(next.length - MAX_OUTPUT_LINES) : next;
			});
		});
		return () => {
			unlistenState();
			unlistenOutput();
		};
	}, [rpc, activeId]);

	// Keep the newest output in view; a person watching an install reads the tail.
	useEffect(() => {
		if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
	}, [lines]);

	// Re-adopt an install this dialog started before a reload. The renderer can
	// be torn down and rebuilt while `bun install` is still running — a window
	// reload, or a daemon restart that kept the install alive — and the events
	// for a run whose id this instance never received are gone. Without this the
	// dialog comes back idle while the install keeps writing to the plugins
	// directory, and the only way to see it is `plugins.install.status` by hand.
	//
	// Adoption is keyed on the spec still in the input, so an install the person
	// has since replaced is not dragged back in front of them.
	const adoptedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!open || !rpc) return;
		const wanted = spec.trim();
		if (wanted === "" || adoptedRef.current === wanted) return;
		let cancelled = false;
		void rpc
			.request<{ installs: InstallView[] }>("plugins.install.status")
			.then(res => {
				if (cancelled) return;
				const live = res?.installs?.find(
					view => view.spec === wanted && (view.state === "inspecting" || view.state === "installing"),
				);
				if (!live) return;
				adoptedRef.current = wanted;
				setView(live);
				return rpc
					.request<{ lines: OutputLine[] }>("plugins.install.output", { installId: live.installId })
					.then(out => {
						if (!cancelled) setLines(out?.lines ?? []);
					});
			})
			.catch(() => {
				// A daemon that cannot be asked has nothing live to adopt; the
				// dialog stays idle and a fresh submit starts a new install.
			});
		return () => {
			cancelled = true;
		};
	}, [open, rpc, spec]);

	// Drag-and-drop: a dropped archive or folder becomes the spec, so a plugin
	// that was never published can be installed without typing a path. The
	// dragged-over state is tracked so the drop target can be seen; a drag that
	// leaves the dialog must clear it or the highlight sticks after the pointer
	// is long gone.
	useEffect(() => {
		if (!dragging) return;
		const clear = (): void => setDragging(false);
		window.addEventListener("dragend", clear);
		window.addEventListener("drop", clear);
		return () => {
			window.removeEventListener("dragend", clear);
			window.removeEventListener("drop", clear);
		};
	}, [dragging]);

	const onDrop = useCallback(
		(event: DragEvent<HTMLDivElement>): void => {
			event.preventDefault();
			setDragging(false);
			if (busy) return;
			const item = event.dataTransfer.items[0];
			// `getAsFile` rather than `files`: Electron needs the File object itself
			// to read a filesystem path off it, and the path is not on the transfer.
			const dropped = item?.getAsFile();
			const path = dropped ? (window.electronAPI?.getDroppedFilePath(dropped) ?? "") : "";
			if (path === "") {
				setError(t("plugin install drop unreadable"));
				return;
			}
			// A folder has no extension to judge, and a directory is the shape a
			// plugin normally takes before it is packed. An archive must be one bun
			// can read; anything else (a .docx, a .png) is refused here so the
			// person learns it immediately instead of from a package-manager error
			// about a spec it could not resolve.
			if (!DROP_ACCEPTED.test(path)) {
				setError(t("plugin install drop unsupported"));
				return;
			}
			setError(null);
			setSpec(path);
		},
		[busy],
	);

	// A finished install leaves its transcript in place — the failure reason is
	// the most useful thing on screen at that moment — and only the next submit
	// clears it.
	const start = useCallback(
		(nextSpec: string): void => {
			const trimmed = nextSpec.trim();
			if (trimmed === "" || !rpc) return;
			setError(null);
			setLines([]);
			setView({ installId: "", spec: trimmed, state: "inspecting" });
			void rpc
				.request<{ installId: string }>("plugins.install", { spec: trimmed })
				.then(res => {
					const installId = res?.installId ?? "";
					if (installId === "") {
						setError(t("plugin install no id"));
						setView(null);
						return;
					}
					setView({ installId, spec: trimmed, state: "inspecting" });
				})
				.catch((e: unknown) => {
					// A spec the classifier refuses lands here. It is the common
					// case for a pasted URL, so the reason is shown rather than
					// collapsed into a generic failure.
					setError(e instanceof Error ? e.message : String(e));
					setView(null);
				});
		},
		[rpc],
	);

	const cancel = useCallback((): void => {
		if (!rpc || !activeId) return;
		void rpc.request("plugins.install.cancel", { installId: activeId }).catch(() => {
			// The state event reports the real outcome; a dropped cancel request
			// shows up as an install that stops a moment later, or not at all.
		});
	}, [rpc, activeId]);

	// Terminal states collapse to a summary line so the dialog does not keep the
	// person staring at a frozen log after the run is decided.
	const phase = view?.state ?? "idle";

	return (
		<DialogFrame open={open} onClose={onClose} label={t("plugin install title")} className="gui-plugin-dialog">
			<div className="gui-dialog-head">
				<Icon name="download" className="h-4 w-4 opacity-70" />
				<span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{t("plugin install title")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} disabled={busy} aria-label={t("close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="gui-plugin-dialog-body">
				<p className="gui-plugin-config-desc">{t("plugin install hint")}</p>

				<div
					className={`gui-plugin-drop${dragging ? " gui-plugin-drop--over" : ""}`}
					onDragOver={event => {
						// Without preventDefault the browser navigates to the dropped
						// file and the whole renderer is replaced.
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={onDrop}
				>
					<div className="gui-ext-plugins-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-50" />
						<input
							ref={inputRef}
							type="text"
							value={spec}
							disabled={busy}
							placeholder={t("plugin install placeholder")}
							aria-label={t("plugin install placeholder")}
							onChange={event => setSpec(event.currentTarget.value)}
							onKeyDown={event => {
								// Enter submits unless an input-method candidate is being
								// confirmed, which is also Enter — submitting there would
								// install a half-typed spec.
								if (event.key === "Enter" && !event.nativeEvent.isComposing) {
									event.preventDefault();
									start(spec);
								}
							}}
						/>
					</div>
					<div className="gui-plugin-drop-hint">{t("plugin install drop hint")}</div>
				</div>

				{error !== null && <div className="gui-ext-plugins-error">{error}</div>}

				{lines.length > 0 && (
					<div className="gui-plugin-log" ref={logRef}>
						{lines.map((line, index) => (
							<div key={index} className={line.stream === "stderr" ? "gui-plugin-log-err" : undefined}>
								{line.text}
							</div>
						))}
					</div>
				)}

				{phase === "done" && view?.capability !== undefined && (
					<div className="gui-ext-detail-section">
						<div className="gui-ext-detail-label">
							{t("plugin install done {name}", {
								name: view.name ?? view.spec,
							})}
						</div>
						<div className="gui-ext-plugins-desc">{view.capability.summary}</div>
					</div>
				)}

				{phase === "failed" && (
					<div className="gui-ext-plugins-error">{view?.message ?? t("plugin install failed")}</div>
				)}
				{phase === "cancelled" && <div className="gui-ext-plugins-desc">{t("plugin install cancelled")}</div>}

				<div className="gui-plugin-dialog-actions">
					{busy ? (
						<button type="button" className="gui-btn" onClick={cancel}>
							{t("plugin install cancel")}
						</button>
					) : (
						<>
							<button type="button" className="gui-btn" onClick={onClose}>
								{t("close")}
							</button>
							<button type="button" className="gui-btn-primary" onClick={() => start(spec)}>
								{phase === "failed" || phase === "cancelled" ? t("retry") : t("plugin install start")}
							</button>
						</>
					)}
				</div>
			</div>
		</DialogFrame>
	);
}
