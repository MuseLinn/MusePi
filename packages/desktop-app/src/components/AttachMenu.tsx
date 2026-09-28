import { t, tLoose } from "@musepi/client-core";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
	FILE_ROW_LIMIT,
	filterFileRows,
	filterPluginRows,
	flattenWorkspaceFiles,
	type PickerTreeEntry,
} from "../lib/plus-pickers";
import type { RpcClient } from "../lib/rpc";
import { bindingLabel } from "../lib/shortcut-registry";
import type { ExtensionItem } from "../lib/slot-host";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

/** Load lifecycle for one picker's source data (fetched once per open). */
type PickerLoad<T> = { kind: "loading" } | { kind: "error" } | { kind: "ready"; data: T };

/** Which「＋」submenu is open — null = the plain attach menu. */
type PickerKind = "plugins" | "files" | null;

/**
 * Attach menu (kimi-code-web parity): ONE paperclip button replacing the
 * old insert (+) menu — image attachment, quick-insert tokens, and the
 * manual mode toggles (plan / goal) with their descriptions. Toggling a
 * mode keeps the menu open so the user can flip several at once; the
 * status chips above the composer reflect the live state.
 */
export function AttachMenu({
	onReady,
	goalMode,
	planMode,
	planDisabled = false,
	goalDisabled = false,
	onToggleGoal,
	onTogglePlan,
	onGuidedGoal,
	onPickImages,
	onPickFiles,
	onSketch,
	onCaptureScreen,
	onInsert,
	rpc,
	cwd,
	onFocusComposer,
}: {
	goalMode: boolean;
	planMode: boolean;
	/** No active session (welcome state): plan/goal toggles are session
	 *  state, so they render disabled with an explanatory tooltip. */
	planDisabled?: boolean;
	goalDisabled?: boolean;
	onToggleGoal(): void;
	onTogglePlan(): void;
	/** TUI /guided-goal parity: the agent interviews the user in chat,
	 *  then creates the goal via its `goal` tool. */
	onGuidedGoal(): void;
	/** Opens the image file picker (attachment entry). */
	onPickImages(files: File[]): void;
	/** Opens the all-types file picker (general attachment entry). Optional:
	 *  the welcome composer has no workspace yet, so file attachments have
	 *  nowhere to land — the menu item is hidden until a session exists. */
	onPickFiles?(files: File[]): void;
	/** Opens the sketch board (Codex 绘画 parity). Works on the welcome
	 *  composer too — the PNG rides the normal image-attachment pipeline,
	 *  no workspace needed. */
	onSketch?(): void;
	/** kimicode 截屏 parity: captures the primary display and opens the
	 *  annotate board on the shot (⇧⌘S also routes here — rebinding lives in
	 *  the shortcut registry, the chip shows the live binding). */
	onCaptureScreen?(): void;
	/** Inserts a token (slash command / @mention / session ref) at the caret. */
	onInsert(token: string): void;
	/** Daemon RPC bridge for the「＋」sub-pickers (extensions.list /
	 *  workspace.tree — no new RPCs, the same sources ExtensionsCenter and
	 *  FilePane read). */
	rpc?: RpcClient | null;
	/** Session cwd (the workspace.tree scope). Optional: without a session
	 *  workspace (welcome composer) the two sub-picker menu items stay
	 *  hidden — same rationale as planDisabled, just hiding instead of
	 *  disabling since there is nothing to act on. */
	cwd?: string;
	/** Focus-back target when a sub-picker closes WITHOUT an insert
	 *  (Esc / outside click): the composer textarea, so keyboard flow
	 *  returns where it started. An insert routes through onInsert which
	 *  focuses the textarea itself. */
	onFocusComposer?(): void;
	/** Hands the host a way to open this menu — the composer frame's
	 *  trailing "+" chip routes here so there is exactly ONE attach surface
	 *  (the anchor and the pickers live in this component; a second picker
	 *  in the frame would drift from this one). */
	onReady?(open: () => void): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [picker, setPicker] = useState<PickerKind>(null);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const pickerOpen = picker !== null;
	const setPickerClosed = (): void => setPicker(null);
	const fileRef = useRef<HTMLInputElement | null>(null);
	const anyFileRef = useRef<HTMLInputElement | null>(null);
	// The sub-picker anchors to the SAME wrapper as the attach menu (the
	// wrapper div hands itself to both — anchorRef above is a callback ref,
	// not a ref object, so its .current is not readable).
	const anchorElRef = useRef<HTMLDivElement | null>(null);
	const { renderMenu: renderPicker } = useFloatingMenu(pickerOpen, setPickerClosed, {
		className: "gui-attach-picker",
		anchor: anchorElRef.current,
	});
	// Sub-picker source data, refetched on every open (extensions can be
	// toggled and the tree can change between opens).
	const [plugins, setPlugins] = useState<PickerLoad<ExtensionItem[]>>({ kind: "loading" });
	const [files, setFiles] = useState<PickerLoad<string[]>>({ kind: "loading" });
	const [pluginQuery, setPluginQuery] = useState("");
	const [fileQuery, setFileQuery] = useState("");
	// Keyboard cursor: active row index per picker (↑/↓ move, Enter picks).
	const [pluginActive, setPluginActive] = useState(0);
	const [fileActive, setFileActive] = useState(0);
	// Deferred so typing into the search box stays responsive: the filter +
	// row render run on the deferred query, not on every keystroke commit.
	const deferredPluginQuery = useDeferredValue(pluginQuery);
	const deferredFileQuery = useDeferredValue(fileQuery);
	// Focus-back bookkeeping: an insert already refocuses the composer via
	// onInsert; only a dismiss-without-insert (Esc / outside click) needs
	// the explicit focus hand-back.
	const pickerWasOpenRef = useRef(false);
	const pickerInsertedRef = useRef(false);
	// Hand the opener up once (stable identity — `setOpen` never changes).
	// Effect, not render: emitting during render would be a side effect in
	// the render phase.
	useEffect(() => onReady?.(() => setOpen(true)), [onReady]);

	// Enabled plugins (extensions.list, ExtensionsCenter parity): "active"
	// is the enabled state — disabled/shadowed entries never make the list.
	useEffect(() => {
		if (picker !== "plugins") return;
		if (!rpc) {
			setPlugins({ kind: "error" });
			return;
		}
		let alive = true;
		setPlugins({ kind: "loading" });
		void rpc
			.request<{ extensions: ExtensionItem[] }>("extensions.list", {})
			.then(res => {
				if (alive) setPlugins({ kind: "ready", data: (res?.extensions ?? []).filter(e => e.state === "active") });
			})
			.catch(() => {
				if (alive) setPlugins({ kind: "error" });
			});
		return () => {
			alive = false;
		};
	}, [picker, rpc]);

	// Workspace files (workspace.tree, FilePane/use-completion parity):
	// relative paths scoped to the session cwd, gitignore respected.
	useEffect(() => {
		if (picker !== "files") return;
		if (!rpc || !cwd) {
			setFiles({ kind: "error" });
			return;
		}
		let alive = true;
		setFiles({ kind: "loading" });
		void rpc
			.request<{ entries: PickerTreeEntry[] }>("workspace.tree", {
				cwd,
				maxDepth: 4,
				perDirLimit: 100,
				gitignore: true,
			})
			.then(res => {
				if (alive) setFiles({ kind: "ready", data: flattenWorkspaceFiles(res?.entries ?? []) });
			})
			.catch(() => {
				if (alive) setFiles({ kind: "error" });
			});
		return () => {
			alive = false;
		};
	}, [picker, rpc, cwd]);

	// Focus hand-back on dismiss-without-insert (see pickerInsertedRef).
	useEffect(() => {
		const was = pickerWasOpenRef.current;
		pickerWasOpenRef.current = pickerOpen;
		if (was && !pickerOpen && !pickerInsertedRef.current) onFocusComposer?.();
	}, [pickerOpen, onFocusComposer]);

	/** Insert via the shared onInsert path (setRangeText at the caret),
	 *  close the picker and let onInsert refocus the composer. */
	const pick = (token: string): void => {
		pickerInsertedRef.current = true;
		onInsert(token);
		setPicker(null);
	};

	/** Menu-item click → close the attach menu, open the sub-picker at the
	 *  same anchor (the floating-menu mutex settles the attach menu). */
	const openPicker = (kind: Exclude<PickerKind, null>): void => {
		pickerInsertedRef.current = false;
		setPluginQuery("");
		setFileQuery("");
		setPluginActive(0);
		setFileActive(0);
		setOpen(false);
		setPicker(kind);
	};

	// Filtered rows run on the deferred query so per-keystroke commits stay
	// cheap (the 200-row cap keeps the list render bounded either way).
	const pluginItems = useMemo(() => {
		if (plugins.kind !== "ready") return [];
		return filterPluginRows(plugins.data, deferredPluginQuery).map(p => ({
			key: p.path || p.name,
			node: (
				<>
					<span className="min-w-0 flex-1">
						<span className="gui-attach-opt-title">{p.displayName || p.name}</span>
						<span className="gui-attach-opt-hint">{p.description || p.path}</span>
					</span>
					<span className="gui-attach-picker-badge">{t("plus picker enabled badge")}</span>
				</>
			),
			token: p.displayName || p.name,
		}));
	}, [plugins, deferredPluginQuery]);
	const fileItems = useMemo(() => {
		if (files.kind !== "ready") return { rows: [] as string[], truncated: false };
		return filterFileRows(files.data, deferredFileQuery);
	}, [files, deferredFileQuery]);

	return (
		<div
			className="gui-model"
			ref={el => {
				anchorElRef.current = el;
				anchorRef(el);
			}}
		>
			<button
				type="button"
				className={`gui-composer-ico${open ? " gui-composer-ico--active" : ""}`}
				onClick={() => setOpen(v => !v)}
				title={t("attach")}
				aria-label={t("attach")}
				aria-expanded={open}
				aria-haspopup="menu"
			>
				<Icon name="add" className="h-3.5 w-3.5" />
			</button>
			{renderMenu(
				<div className="gui-attach-menu" role="menu" aria-label={t("attach")}>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							fileRef.current?.click();
						}}
					>
						<Icon name="file-image" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("add images")}</span>
							<span className="gui-attach-opt-hint">{tLoose("add images desc")}</span>
						</span>
					</button>
					{/* kimicode "+" menu parity: icon + label + one-line desc per
					 *  row; the 截屏 row carries the LIVE binding from the
					 *  shortcut registry (rebinding in 设置 → 快捷键 shows up
					 *  here immediately). */}
					{onCaptureScreen && (
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								onCaptureScreen();
								setOpen(false);
							}}
						>
							<Icon name="camera" className="h-4 w-4 gui-attach-opt-ico" />
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{tLoose("attach capture screen")}</span>
								<span className="gui-attach-opt-hint">{tLoose("attach capture screen desc")}</span>
							</span>
							<kbd className="gui-attach-keys">{bindingLabel("capture-screen")}</kbd>
						</button>
					)}
					{onSketch && (
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								onSketch();
								setOpen(false);
							}}
						>
							<Icon name="palette" className="h-4 w-4 gui-attach-opt-ico" />
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{t("sketch")}</span>
								<span className="gui-attach-opt-hint">{tLoose("sketch desc")}</span>
							</span>
						</button>
					)}
					{onPickFiles && (
						<button
							type="button"
							className="gui-attach-opt"
							role="menuitem"
							onClick={() => {
								anyFileRef.current?.click();
							}}
						>
							<Icon name="file" className="h-4 w-4 gui-attach-opt-ico" />
							<span className="min-w-0 flex-1">
								<span className="gui-attach-opt-title">{t("add attachments")}</span>
								<span className="gui-attach-opt-hint">{tLoose("add attachments desc")}</span>
							</span>
						</button>
					)}
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							onInsert("/");
							setOpen(false);
						}}
					>
						<Icon name="terminal" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert command")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert command desc")}</span>
						</span>
					</button>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							onInsert("@");
							setOpen(false);
						}}
					>
						<Icon name="chat-1" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("mention file")}</span>
							<span className="gui-attach-opt-hint">{tLoose("mention file desc")}</span>
						</span>
					</button>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						onClick={() => {
							onInsert("#");
							setOpen(false);
						}}
					>
						<Icon name="chat-3" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert session")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert session desc")}</span>
						</span>
					</button>
					<div className="gui-creds-menu-sep" />
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						title={t("insert magic keyword hint")}
						onClick={() => {
							onInsert(" ultrathink ");
							setOpen(false);
						}}
					>
						<Icon name="brain-ai-3" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert ultrathink")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert ultrathink desc")}</span>
						</span>
					</button>
					<button
						type="button"
						className="gui-attach-opt"
						role="menuitem"
						title={t("insert magic keyword hint")}
						onClick={() => {
							onInsert(" workflowz ");
							setOpen(false);
						}}
					>
						<Icon name="git-branch" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("insert workflowz")}</span>
							<span className="gui-attach-opt-hint">{tLoose("insert workflowz desc")}</span>
						</span>
					</button>
					<div className="gui-creds-menu-sep" />
					<button
						type="button"
						className={`gui-attach-opt${planMode ? " gui-attach-opt--on" : ""}${planDisabled ? " gui-attach-opt--disabled" : ""}`}
						role="menuitemcheckbox"
						aria-checked={planMode}
						disabled={planDisabled}
						title={planDisabled ? t("start a session to use plan mode") : undefined}
						onClick={onTogglePlan}
					>
						<Icon name="compass-3" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("plan mode")}</span>
							<span className="gui-attach-opt-hint">{t("plan mode hint")}</span>
						</span>
						<span className={`gui-attach-switch${planMode ? " gui-attach-switch--on" : ""}`} aria-hidden>
							<span className="gui-attach-switch-knob" />
						</span>
					</button>
					<button
						type="button"
						className={`gui-attach-opt${goalMode ? " gui-attach-opt--on" : ""}${goalDisabled ? " gui-attach-opt--disabled" : ""}`}
						role="menuitemcheckbox"
						aria-checked={goalMode}
						disabled={goalDisabled}
						title={goalDisabled ? t("start a session to use goal mode") : undefined}
						onClick={onToggleGoal}
					>
						<Icon name="target" className="h-4 w-4 gui-attach-opt-ico" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("goal mode")}</span>
							<span className="gui-attach-opt-hint">{t("goal mode hint")}</span>
						</span>
						<span className={`gui-attach-switch${goalMode ? " gui-attach-switch--on" : ""}`} aria-hidden>
							<span className="gui-attach-switch-knob" />
						</span>
					</button>
					<button
						type="button"
						className={`gui-attach-opt${goalDisabled ? " gui-attach-opt--disabled" : ""}`}
						role="menuitem"
						disabled={goalDisabled}
						title={goalDisabled ? t("start a session to use goal mode") : undefined}
						onClick={() => {
							onGuidedGoal();
							setOpen(false);
						}}
					>
						<Icon name="chat-1" className="h-4 w-4" />
						<span className="min-w-0 flex-1">
							<span className="gui-attach-opt-title">{t("guided goal mode")}</span>
							<span className="gui-attach-opt-hint">{t("guided goal mode hint")}</span>
						</span>
					</button>
					{/* M2-2.6 third segment: enabled plugins / workspace files.
					 *  Both need a session workspace, so without `cwd` (welcome
					 *  composer) the whole segment stays hidden. Picking a row
					 *  swaps the attach menu for the sub-picker at this anchor. */}
					{cwd && (
						<>
							<div className="gui-creds-menu-sep" />
							<button
								type="button"
								className="gui-attach-opt"
								role="menuitem"
								onClick={() => openPicker("plugins")}
							>
								<Icon name="plug-2" className="h-4 w-4 gui-attach-opt-ico" />
								<span className="min-w-0 flex-1">
									<span className="gui-attach-opt-title">{t("plus enabled plugins")}</span>
									<span className="gui-attach-opt-hint">{t("plus enabled plugins desc")}</span>
								</span>
							</button>
							<button
								type="button"
								className="gui-attach-opt"
								role="menuitem"
								onClick={() => openPicker("files")}
							>
								<Icon name="folder-open" className="h-4 w-4 gui-attach-opt-ico" />
								<span className="min-w-0 flex-1">
									<span className="gui-attach-opt-title">{t("plus workspace files")}</span>
									<span className="gui-attach-opt-hint">{t("plus workspace files desc")}</span>
								</span>
							</button>
						</>
					)}
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={e => {
							const files = e.target.files ? [...e.target.files] : [];
							if (files.length > 0) onPickImages(files);
							e.target.value = "";
						}}
					/>
					{/* General attachment entry (openchamber parity): NO accept
					 *  restriction — any file the OS picker allows becomes a chip;
					 *  the send path routes it through fs.write into the workspace. */}
					<input
						ref={anyFileRef}
						type="file"
						multiple
						hidden
						onChange={e => {
							const files = e.target.files ? [...e.target.files] : [];
							if (files.length > 0) onPickFiles?.(files);
							e.target.value = "";
						}}
					/>
				</div>,
			)}
			{/* Sub-picker (M2-2.6): opens at the same anchor AFTER the attach
			 *  menu closes — one floating-menu instance per surface, settled
			 *  by the shared mutex. */}
			{renderPicker(
				/* Plain content — the card class (.gui-attach-picker) lives on
				 *  the portal wrapper (className option); a second layer would
				 *  double the padding/width (use-floating-menu contract). */
				<div
					role="dialog"
					aria-label={picker === "plugins" ? t("plus enabled plugins") : t("plus workspace files")}
				>
					{picker === "plugins" ? (
						<AttachPicker
							title={t("plus enabled plugins")}
							query={pluginQuery}
							onQuery={q => {
								setPluginQuery(q);
								setPluginActive(0);
							}}
							load={plugins}
							emptyText={t("plus picker no plugins")}
							active={pluginActive}
							onActive={setPluginActive}
							onPickIndex={i => {
								const item = pluginItems[i];
								// Plain plugin name, NO prefix and NO trailing
								// space: @ is files, # is sessions — a prefix here
								// would collide with the existing completions.
								if (item) pick(item.token);
							}}
							items={pluginItems}
						/>
					) : picker === "files" ? (
						<AttachPicker
							title={t("plus workspace files")}
							query={fileQuery}
							onQuery={q => {
								setFileQuery(q);
								setFileActive(0);
							}}
							load={files}
							emptyText={t("plus picker no files")}
							active={fileActive}
							onActive={setFileActive}
							onPickIndex={i => {
								const path = fileItems.rows[i];
								// use-completion insertAt parity: `@relative/path `
								// (trailing space) — the send path rides the
								// existing fileMention pipeline, zero backend work.
								if (path) pick(`@${path} `);
							}}
							items={fileItems.rows.map(path => ({
								key: path,
								node: <span className="gui-attach-picker-path">{path}</span>,
							}))}
							footer={
								fileItems.truncated ? (
									<div className="gui-attach-picker-note">
										{t("plus picker truncated", { n: FILE_ROW_LIMIT })}
									</div>
								) : undefined
							}
						/>
					) : null}
				</div>,
			)}
		</div>
	);
}

/**
 * Shared body of the「＋」sub-pickers (enabled plugins / workspace files,
 * M2-2.6): title row + search input + scrolling row list on the same
 * frosted surface as the attach menu (the wrapper is .gui-menu-popup).
 * Contract: ↑/↓ move the active row, Enter picks it, Escape and
 * outside-mousedown close the popup — both are claimed by
 * use-floating-menu's document listeners, so the composer's own Escape
 * bindings never fire. Loading / error / empty / no-result all render as
 * a note row; rows reuse .gui-attach-opt for the attach-menu look.
 */
function AttachPicker({
	title,
	query,
	onQuery,
	load,
	items,
	active,
	onActive,
	onPickIndex,
	emptyText,
	footer,
}: {
	title: string;
	query: string;
	onQuery(query: string): void;
	load: PickerLoad<unknown>;
	items: { key: string; node: ReactNode }[];
	active: number;
	onActive(index: number): void;
	onPickIndex(index: number): void;
	/** Shown when the source list itself is empty (no query typed). */
	emptyText: string;
	footer?: ReactNode;
}): ReactNode {
	const listRef = useRef<HTMLDivElement | null>(null);
	// Keep the keyboard-driven active row in view; block:"nearest" never
	// scrolls anything beyond the list container.
	useEffect(() => {
		listRef.current?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
	}, [active, items.length]);

	const onKeyDown = (e: ReactKeyboardEvent): void => {
		if (items.length === 0) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			onActive(Math.min(active + 1, items.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			onActive(Math.max(active - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (active < items.length) onPickIndex(active);
		}
		// Escape is intentionally NOT handled here: it bubbles to
		// use-floating-menu's document keydown, which preventDefaults and
		// closes the popup (focus returns via onFocusComposer).
	};

	return (
		<>
			<div className="gui-attach-picker-title">{title}</div>
			<input
				type="text"
				className="gui-attach-picker-search"
				value={query}
				onChange={e => onQuery(e.target.value)}
				onKeyDown={onKeyDown}
				placeholder={t("plus picker search")}
				spellCheck={false}
				autoFocus
			/>
			{load.kind === "loading" ? (
				<div className="gui-attach-picker-note">{t("plus picker loading")}</div>
			) : load.kind === "error" ? (
				<div className="gui-attach-picker-note">{t("plus picker load failed")}</div>
			) : items.length === 0 ? (
				<div className="gui-attach-picker-note">{query ? t("plus picker no results") : emptyText}</div>
			) : (
				<div className="gui-attach-picker-list" role="listbox" ref={listRef}>
					{items.map((item, i) => (
						<button
							key={item.key}
							type="button"
							className={`gui-attach-opt${i === active ? " gui-attach-opt--active" : ""}`}
							data-active={i === active}
							role="option"
							aria-selected={i === active}
							// Hover keeps the mouse and the keyboard highlight on
							// the same row, so Enter always picks what's visible.
							onMouseEnter={() => onActive(i)}
							onClick={() => onPickIndex(i)}
						>
							{item.node}
						</button>
					))}
				</div>
			)}
			{footer}
		</>
	);
}
