import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirm, usePrompt } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * Project knowledge panel (right-panel 项目知识, openchamber v1.19
 * ProjectNotesTodoPanel parity): notes / todos / plans with a cross-section
 * search, a right section nav (drag-to-resize), and plans that open AND edit
 * in place — the panel owns the only scroller.
 *
 * Notes are multi-entry cards (daemon notes.list/create/update/delete), one
 * expanded at a time with a local debounced draft. Todos stay per-workspace
 * localStorage. Plans live in daemon files (plans.*) and edit in-place via
 * plans.save with the id.
 */

interface TodoItem {
	id: string;
	text: string;
	done: boolean;
	createdAt: number;
}

interface PlanFile {
	id: string;
	title: string;
	createdAt: string;
}

interface NoteFile {
	id: string;
	body: string;
	createdAt: string;
	updatedAt: string;
}

const TODO_STORAGE_PREFIX = "musepi-gui-todos:";
const TODO_TEXT_MAX = 120;
const NOTE_BODY_MAX = 3000;
const NOTE_SAVE_DEBOUNCE_MS = 400;
const SECTION_KEY = "musepi-gui-notes-section";
const NAV_W_KEY = "musepi-gui-notes-nav-w";
const COMPOSER_H_KEY = "musepi-gui-notes-h";
const NAV_W_MIN = 96;
const NAV_W_MAX = 240;

type Section = "notes" | "todos" | "plans";
const SECTIONS: Section[] = ["notes", "todos", "plans"];
const SECTION_ICONS: Record<Section, IconName> = { notes: "sticky-note", todos: "checkbox-circle", plans: "file-text" };
const SECTION_LABEL: Record<Section, string> = {
	notes: t("knowledge notes"),
	todos: t("todos"),
	plans: t("knowledge plans"),
};

function loadTodos(cwd: string): TodoItem[] {
	try {
		const raw = localStorage.getItem(`${TODO_STORAGE_PREFIX}${cwd}`);
		const parsed = raw ? (JSON.parse(raw) as TodoItem[]) : [];
		return parsed.map(t => ({ id: t.id, text: t.text, done: t.done, createdAt: t.createdAt ?? Date.now() }));
	} catch {
		return [];
	}
}

const clampNavW = (w: number): number => Math.min(NAV_W_MAX, Math.max(NAV_W_MIN, Math.round(w)));

function readNum(key: string, fallback: number, min: number, max: number): number {
	try {
		const v = Number.parseInt(localStorage.getItem(key) ?? "", 10);
		return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
	} catch {
		return fallback;
	}
}

/* ── Note card (openchamber v1.19 KnowledgeCard parity) ──────────────── */

/**
 * One note as a card: collapsed = 3-line preview, opens on a click anywhere;
 * expanded = an in-place editor that closes only through its collapse action
 * (a stray click in the text must not throw the editor away). The draft is
 * local + debounced; a blanked body restores the last saved text instead of
 * persisting (the daemon rejects it); deleting is the explicit action.
 */
function NoteCard({
	note,
	expanded,
	onToggle,
	onSave,
	onDelete,
}: {
	note: NoteFile;
	expanded: boolean;
	onToggle(): void;
	onSave(body: string): void;
	onDelete(): void;
}): ReactNode {
	const [draft, setDraft] = useState(note.body);
	const lastSavedRef = useRef(note.body);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Adopt an external change only while this row is untouched since its
	// last save ("add to notes" must reach an open panel, never eat typing).
	useEffect(() => {
		if (note.body === lastSavedRef.current) return;
		if (draft !== lastSavedRef.current) return;
		lastSavedRef.current = note.body;
		setDraft(note.body);
	}, [draft, note.body]);

	useEffect(() => {
		if (draft === lastSavedRef.current) return;
		debounceRef.current = setTimeout(() => {
			debounceRef.current = null;
			if (!draft.trim()) return;
			lastSavedRef.current = draft;
			onSave(draft);
		}, NOTE_SAVE_DEBOUNCE_MS);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [draft, onSave]);

	const handleBlur = (): void => {
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		if (draft === lastSavedRef.current) return;
		if (!draft.trim()) {
			setDraft(lastSavedRef.current);
			return;
		}
		lastSavedRef.current = draft;
		onSave(draft);
	};

	return (
		<li
			className={`gui-knowledge-card${expanded ? "" : " gui-knowledge-card--collapsed"}`}
			onClick={expanded ? undefined : onToggle}
			onKeyDown={
				expanded
					? undefined
					: e => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onToggle();
							}
						}
			}
			role={expanded ? undefined : "button"}
			tabIndex={expanded ? undefined : 0}
			aria-label={expanded ? undefined : t("knowledge expand note")}
		>
			<div className="flex min-w-0 items-start gap-1">
				<div className="min-w-0 flex-1">
					{expanded ? (
						<textarea
							autoFocus
							className="gui-notes-editor w-full resize-none rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5 text-[12.5px] leading-relaxed text-[var(--color-text)] outline-none"
							rows={Math.min(16, Math.max(4, draft.split("\n").length + 1))}
							value={draft}
							maxLength={NOTE_BODY_MAX}
							spellCheck={false}
							onChange={e => setDraft(e.target.value.slice(0, NOTE_BODY_MAX))}
							onBlur={handleBlur}
						/>
					) : (
						<p
							className="line-clamp-3 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--color-text)]"
							title={draft}
						>
							{draft}
						</p>
					)}
				</div>
				{/* Stopped here rather than on each control: every action is a
				 * click on the card too, and without this each would toggle it. */}
				<div
					className="flex flex-shrink-0 flex-col items-center gap-0.5"
					onClick={e => e.stopPropagation()}
					onKeyDown={e => e.stopPropagation()}
				>
					{expanded && (
						<button
							type="button"
							className="gui-btn gui-btn--icon"
							onClick={onToggle}
							title={t("collapse")}
							aria-label={t("collapse")}
						>
							<Icon name="arrow-up-s" className="h-3 w-3" />
						</button>
					)}
					<button
						type="button"
						className="gui-btn gui-btn--icon"
						onClick={onDelete}
						title={t("delete note")}
						aria-label={t("delete note")}
					>
						<Icon name="delete-bin" className="h-3 w-3" />
					</button>
				</div>
			</div>
		</li>
	);
}

/* ── Sections ────────────────────────────────────────────────────────── */

function NotesSection({
	rpc,
	cwd,
	notes,
	query,
	onChanged,
}: {
	rpc: RpcClient;
	cwd: string;
	notes: NoteFile[];
	query: string;
	onChanged(): void;
}): ReactNode {
	const [composer, setComposer] = useState("");
	const [composerH, setComposerH] = useState(() => readNum(COMPOSER_H_KEY, 160, 80, 400));
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	useScrollShadow(composerRef);
	const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
	const onResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
		resizeRef.current = { startY: e.clientY, startH: composerH };
		const move = (ev: PointerEvent): void => {
			const s = resizeRef.current;
			if (!s) return;
			const next = Math.min(400, Math.max(80, s.startH + (ev.clientY - s.startY)));
			setComposerH(next);
			try {
				localStorage.setItem(COMPOSER_H_KEY, String(next));
			} catch {
				// storage unavailable
			}
		};
		const up = (): void => {
			resizeRef.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	const [expandedId, setExpandedId] = useState<string | null>(null);
	const needle = query.trim().toLowerCase();
	const filtered = needle ? notes.filter(n => n.body.toLowerCase().includes(needle)) : notes;

	const addNote = async (): Promise<void> => {
		const body = composer.trim();
		if (!body) return;
		await rpc.request("notes.create", { cwd, body }).catch(() => {});
		setComposer("");
		onChanged();
	};
	const saveBody = async (id: string, body: string): Promise<void> => {
		await rpc.request("notes.update", { cwd, id, body }).catch(() => {});
		onChanged();
	};
	const removeNote = async (id: string): Promise<void> => {
		await rpc.request("notes.delete", { cwd, id }).catch(() => {});
		if (expandedId === id) setExpandedId(null);
		onChanged();
	};

	return (
		<div className="flex flex-col gap-2">
			{/* Composer: fixed-height resizable field + counter + add (the add
			 * lives in the field's own footer, not beside it). */}
			<div className="flex flex-col">
				<textarea
					ref={composerRef}
					className="gui-notes-editor resize-none overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2.5 text-[12.5px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
					style={{ height: composerH }}
					value={composer}
					maxLength={NOTE_BODY_MAX}
					placeholder={t("notes placeholder")}
					spellCheck={false}
					onChange={e => setComposer(e.target.value.slice(0, NOTE_BODY_MAX))}
				/>
				<div className="gui-notes-resize-y" onPointerDown={onResizeStart} aria-hidden />
				<div className="flex items-center justify-between px-0.5 pt-0.5">
					<span className="text-[11px] text-[var(--color-text-faint)]">
						{composer.length}/{NOTE_BODY_MAX}
					</span>
					<button
						type="button"
						className="gui-btn gui-btn-icon"
						onClick={() => void addNote()}
						disabled={!composer.trim()}
						title={t("add knowledge note")}
						aria-label={t("add knowledge note")}
					>
						<Icon name="add" className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			{filtered.length === 0 ? (
				<p className="rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40 px-3 py-3 text-[12px] text-[var(--color-text-faint)]">
					{needle ? t("knowledge no results") : t("no notes yet")}
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{filtered.map(note => (
						<NoteCard
							key={note.id}
							note={note}
							expanded={expandedId === note.id}
							onToggle={() => setExpandedId(cur => (cur === note.id ? null : note.id))}
							onSave={body => void saveBody(note.id, body)}
							onDelete={() => void removeNote(note.id)}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function TodosSection({
	todos,
	query,
	onPersist,
}: {
	todos: TodoItem[];
	query: string;
	onPersist(next: TodoItem[]): void;
}): ReactNode {
	const [todoInput, setTodoInput] = useState("");
	const needle = query.trim().toLowerCase();
	const filtered = needle ? todos.filter(t => t.text.toLowerCase().includes(needle)) : todos;
	const doneCount = todos.filter(t => t.done).length;

	const addTodo = (): void => {
		const value = todoInput.trim().slice(0, TODO_TEXT_MAX);
		if (!value) return;
		// openchamber: insert before the first completed item.
		const firstDone = todos.findIndex(t => t.done);
		const next = [...todos];
		next.splice(firstDone === -1 ? next.length : firstDone, 0, {
			id: crypto.randomUUID(),
			text: value,
			done: false,
			createdAt: Date.now(),
		});
		onPersist(next);
		setTodoInput("");
	};
	const toggleTodo = (id: string): void => {
		// openchamber: completing moves the item to the end (completed-last).
		const target = todos.find(t => t.id === id);
		if (!target) return;
		const rest = todos.filter(t => t.id !== id);
		const next = target.done ? [...rest, { ...target, done: false }] : [...rest, { ...target, done: true }];
		onPersist(next);
	};
	const removeTodo = (id: string): void => {
		onPersist(todos.filter(t => t.id !== id));
	};
	const clearDone = (): void => {
		onPersist(todos.filter(t => !t.done));
	};

	return (
		<div className="gui-notes-todos flex flex-col">
			<div className="flex items-center justify-between px-1 pt-1">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="gui-group-label px-2">{t("todo count items", { count: todos.length })}</span>
					<span className="text-[11px] text-[var(--color-text-faint)]">
						{todoInput.length}/{TODO_TEXT_MAX}
					</span>
				</span>
				<button
					type="button"
					className="gui-link text-[11.5px]"
					disabled={doneCount === 0}
					onClick={clearDone}
					title={doneCount === 0 ? t("clear done disabled") : t("clear done")}
				>
					{t("clear done")}
				</button>
			</div>
			<div className="flex items-center gap-1 px-1 pt-1">
				<input
					className="gui-input min-w-0 flex-1 !px-2 !py-1 text-[12px]"
					value={todoInput}
					maxLength={TODO_TEXT_MAX}
					placeholder={t("add todo placeholder")}
					onChange={e => setTodoInput(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") addTodo();
					}}
				/>
				<button type="button" className="gui-btn gui-btn-icon" onClick={addTodo} title={t("add todo")}>
					<Icon name="add" className="h-3.5 w-3.5" />
				</button>
			</div>
			{filtered.length === 0 ? (
				<p className="rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40 px-3 py-3 text-[12px] text-[var(--color-text-faint)]">
					{needle ? t("knowledge no results") : t("no todos yet")}
				</p>
			) : (
				<div className="mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40">
					<ul className="gui-notes-todo-list">
						{filtered.map(todo => (
							<li key={todo.id} className="gui-notes-todo-row">
								<button
									type="button"
									className={`gui-notes-todo-check${todo.done ? " gui-notes-todo-check--done" : ""}`}
									onClick={() => toggleTodo(todo.id)}
									title={todo.done ? t("mark undone") : t("mark done")}
								>
									{todo.done && <Icon name="check" className="h-2.5 w-2.5" />}
								</button>
								<span className={`gui-notes-todo-text${todo.done ? " gui-notes-todo-text--done" : ""}`}>
									{todo.text}
								</span>
								<button
									type="button"
									className="gui-notes-todo-remove"
									onClick={() => removeTodo(todo.id)}
									title={t("remove todo")}
								>
									✕
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** Plan list; clicking a plan opens its editor IN the panel (v1.19 parity). */
function PlansSection({
	plans,
	query,
	onOpen,
	onCreate,
	onDelete,
}: {
	plans: PlanFile[];
	query: string;
	onOpen(id: string): void;
	onCreate(): void;
	onDelete(id: string): void;
}): ReactNode {
	const needle = query.trim().toLowerCase();
	const filtered = needle ? plans.filter(p => `${p.title} ${p.id}`.toLowerCase().includes(needle)) : plans;
	return (
		<div className="flex flex-col">
			<div className="flex items-center justify-between px-1 pt-1">
				<span className="gui-group-label px-2">{t("plan count files", { count: plans.length })}</span>
				<button type="button" className="gui-btn gui-btn-icon" onClick={onCreate} title={t("new plan")}>
					<Icon name="add" className="h-3.5 w-3.5" />
				</button>
			</div>
			{filtered.length === 0 ? (
				<p className="rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40 px-3 py-3 text-[12px] text-[var(--color-text-faint)]">
					{needle ? t("knowledge no results") : t("no plans yet")}
				</p>
			) : (
				<div className="mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40">
					<ul className="gui-notes-plan-list">
						{filtered.map(plan => (
							<li key={plan.id} className="gui-notes-plan-row">
								<button
									type="button"
									className="gui-notes-plan-open-btn"
									onClick={() => onOpen(plan.id)}
									title={plan.title}
								>
									<span className="gui-notes-plan-title">{plan.title}</span>
									<span className="gui-notes-plan-date">{plan.createdAt}</span>
								</button>
								<button
									type="button"
									className="gui-notes-todo-remove"
									onClick={() => onDelete(plan.id)}
									title={t("delete plan")}
								>
									✕
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/** Plan editor, opened in place of the list (v1.19: plans open in the panel
 *  itself, back control in the panel header; the editor scrolls itself so the
 *  content column stops scrolling while a plan is open). */
function PlanEditor({
	rpc,
	cwd,
	plan,
	onBack,
	onChanged,
}: {
	rpc: RpcClient;
	cwd: string;
	plan: { id: string; title: string; body: string };
	onBack(): void;
	onChanged(): void;
}): ReactNode {
	const [title, setTitle] = useState(plan.title);
	const [body, setBody] = useState(plan.body);
	const [saved, setSaved] = useState(false);
	const bodyRef = useRef<HTMLTextAreaElement | null>(null);
	useScrollShadow(bodyRef);

	const save = async (): Promise<void> => {
		const nextTitle = title.trim() || "untitled plan";
		await rpc.request("plans.save", { cwd, id: plan.id, title: nextTitle, body }).catch(() => {});
		setSaved(true);
		setTimeout(() => setSaved(false), 1200);
		onChanged();
	};

	return (
		<div className="flex h-full min-h-0 flex-col gap-2 px-1 pt-1">
			<div className="flex items-center gap-1.5">
				<button
					type="button"
					className="gui-btn gui-btn--icon"
					onClick={onBack}
					title={t("back")}
					aria-label={t("back")}
				>
					<Icon name="arrow-left-s" className="h-3.5 w-3.5" />
				</button>
				<input
					className="gui-input min-w-0 flex-1 !px-2 !py-1 text-[12.5px] font-medium"
					value={title}
					onChange={e => setTitle(e.target.value)}
					placeholder={t("new plan title")}
					aria-label={t("new plan title")}
				/>
				<button type="button" className="gui-btn gui-btn-icon" onClick={() => void save()} title={t("save")}>
					<Icon name={saved ? "check" : "download"} className="h-3.5 w-3.5" />
					<span className="text-[12px]">{saved ? t("saved") : t("save")}</span>
				</button>
			</div>
			<textarea
				ref={bodyRef}
				className="gui-notes-editor min-h-0 flex-1 resize-none overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2.5 text-[12.5px] leading-relaxed text-[var(--color-text)] outline-none"
				value={body}
				spellCheck={false}
				placeholder={t("new plan body")}
				onChange={e => setBody(e.target.value)}
				onBlur={() => void save()}
			/>
		</div>
	);
}

/* ── Container ───────────────────────────────────────────────────────── */

/**
 * Project knowledge (right-panel 项目知识, openchamber v1.19 parity):
 * content column + right section nav (notes/todos/plans, drag-resize,
 * active section persisted), cross-section search in the title row with
 * per-section match counts, one scroller owned by the panel.
 */
export function NotesPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	const [section, setSectionRaw] = useState<Section>(() => {
		try {
			const s = localStorage.getItem(SECTION_KEY);
			return SECTIONS.includes(s as Section) ? (s as Section) : "notes";
		} catch {
			return "notes";
		}
	});
	const setSection = (s: Section): void => {
		setSectionRaw(s);
		try {
			localStorage.setItem(SECTION_KEY, s);
		} catch {
			// storage unavailable
		}
	};
	const [query, setQuery] = useState("");
	const [notes, setNotes] = useState<NoteFile[] | null>(null);
	const [plans, setPlans] = useState<PlanFile[] | null>(null);
	const [planOpen, setPlanOpen] = useState<{ id: string; title: string; body: string } | null>(null);
	const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos(cwd));
	const [navW, setNavW] = useState(() => readNum(NAV_W_KEY, 120, NAV_W_MIN, NAV_W_MAX));

	const loadPlans = useCallback((): void => {
		void rpc
			.request<{ plans?: PlanFile[] }>("plans.list", { cwd })
			.then(res => setPlans(res.plans ?? []))
			.catch(() => setPlans([]));
	}, [rpc, cwd]);
	const loadNotes = useCallback((): void => {
		void rpc
			.request<{ notes?: NoteFile[] }>("notes.list", { cwd })
			.then(res => setNotes(res.notes ?? []))
			.catch(() => setNotes([]));
	}, [rpc, cwd]);
	useEffect(() => {
		loadNotes();
		loadPlans();
	}, [loadNotes, loadPlans]);
	// A plan belongs to its section and to this project; leaving either must
	// not leave its editor open over a list it no longer matches. The query
	// resets on project change (a query for the old project would hide
	// everything in the new one).
	useEffect(() => {
		setPlanOpen(null);
		setQuery("");
	}, [cwd]);
	useEffect(() => {
		setPlanOpen(null);
	}, [section]);

	const persistTodos = (next: TodoItem[]): void => {
		setTodos(next);
		try {
			localStorage.setItem(`${TODO_STORAGE_PREFIX}${cwd}`, JSON.stringify(next));
		} catch {
			// storage unavailable
		}
	};

	const createPlan = async (): Promise<void> => {
		const title = await prompt({ title: t("new plan title") });
		if (!title) return;
		const body = await prompt({ title: t("new plan body") });
		if (body === null) return;
		try {
			await rpc.request("plans.save", { cwd, title, body });
		} catch {
			// daemon rejected — keep list as-is
		}
		loadPlans();
	};
	const openPlan = async (id: string): Promise<void> => {
		try {
			const res = await rpc.request<{ title?: string; body?: string; error?: string }>("plans.get", { cwd, id });
			if (res.error || !res.body) return;
			// Body arrives with the `# title` heading the daemon writes on
			// save; the editor owns title separately.
			const bodyNoHeading = res.body.replace(/^#\s+.+\n+/, "");
			setPlanOpen({ id, title: res.title ?? id, body: bodyNoHeading });
		} catch {
			// not found — ignore
		}
	};
	const deletePlan = async (id: string): Promise<void> => {
		const ok = await confirm(t("confirm delete plan"));
		if (!ok) return;
		try {
			await rpc.request("plans.delete", { cwd, id });
		} catch {
			// daemon rejected
		}
		if (planOpen?.id === id) setPlanOpen(null);
		loadPlans();
	};

	// Cross-section search counts (filtered), per-section on the nav entries.
	const needle = query.trim().toLowerCase();
	const notesCount = notes ? notes.filter(n => !needle || n.body.toLowerCase().includes(needle)).length : 0;
	const todosCount = todos.filter(t => !needle || t.text.toLowerCase().includes(needle)).length;
	const plansCount = plans
		? plans.filter(p => !needle || `${p.title} ${p.id}`.toLowerCase().includes(needle)).length
		: 0;
	// Follow the search to where the matches are: a query whose hits live in
	// another section must not leave an empty list on screen.
	useEffect(() => {
		if (!needle) return;
		const counts: Record<Section, number> = { notes: notesCount, todos: todosCount, plans: plansCount };
		if (counts[section] > 0) return;
		const next = SECTIONS.find(s => counts[s] > 0);
		if (next) setSection(next);
	}, [needle, section, notesCount, todosCount, plansCount]);

	const navResizeRef = useRef<{ startX: number; startW: number } | null>(null);
	const onNavResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
		navResizeRef.current = { startX: e.clientX, startW: navW };
		const move = (ev: PointerEvent): void => {
			const s = navResizeRef.current;
			if (!s) return;
			const next = clampNavW(s.startW + (s.startX - ev.clientX));
			setNavW(next);
		};
		const up = (): void => {
			navResizeRef.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			try {
				localStorage.setItem(NAV_W_KEY, String(navW));
			} catch {
				// storage unavailable
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	const counts: Record<Section, number> = { notes: notesCount, todos: todosCount, plans: plansCount };

	return (
		<div className="flex h-full min-h-0 w-full min-w-0 flex-col">
			{/* Title + search share a row: search filters what is already on
			 * screen; the back control appears here while a plan is open
			 * (PlanEditor titles the plan itself, so a second title row
			 * would say the same thing twice). */}
			<div className="flex flex-shrink-0 items-center gap-1.5 px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("project knowledge")}</span>
				<div className="relative ml-auto w-36 min-w-0 flex-shrink-0">
					<Icon
						name="search"
						className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-faint)]"
					/>
					<input
						className="gui-input h-7 w-full rounded-md !py-0.5 pl-6 pr-6 text-[12px]"
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder={t("knowledge search")}
						aria-label={t("knowledge search")}
					/>
					{query && (
						<button
							type="button"
							className="absolute right-1 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
							onClick={() => setQuery("")}
							aria-label={t("clear")}
							title={t("clear")}
						>
							<Icon name="close" className="h-3 w-3" />
						</button>
					)}
				</div>
			</div>
			<div className="flex min-h-0 flex-1">
				{/* Content column: the panel owns the only scroller. While a plan
				 * is open the editor scrolls itself and the column stops. */}
				<div className={`min-h-0 min-w-0 flex-1 px-2.5 pb-3${planOpen ? " overflow-hidden" : " overflow-y-auto"}`}>
					{section === "notes" && notes !== null && (
						<NotesSection rpc={rpc} cwd={cwd} notes={notes} query={query} onChanged={loadNotes} />
					)}
					{section === "notes" && notes === null && (
						<p className="px-2 pt-1 text-[12.5px] text-[var(--color-text-faint)]">{t("loading")}…</p>
					)}
					{section === "todos" && <TodosSection todos={todos} query={query} onPersist={persistTodos} />}
					{section === "plans" && planOpen && (
						<PlanEditor
							rpc={rpc}
							cwd={cwd}
							plan={planOpen}
							onBack={() => setPlanOpen(null)}
							onChanged={loadPlans}
						/>
					)}
					{section === "plans" && !planOpen && plans !== null && (
						<PlansSection
							plans={plans}
							query={query}
							onOpen={id => void openPlan(id)}
							onCreate={() => void createPlan()}
							onDelete={id => void deletePlan(id)}
						/>
					)}
				</div>
				{/* Section nav (openchamber v1.19: content left, sections right —
				 * the same arrangement the files surface uses). */}
				<nav className="gui-knowledge-nav" style={{ width: navW }} aria-label={t("project knowledge")}>
					<div
						className="gui-knowledge-nav-resize"
						onPointerDown={onNavResizeStart}
						role="separator"
						aria-orientation="vertical"
						aria-label={t("knowledge resize sections")}
					/>
					{SECTIONS.map(s => (
						<button
							key={s}
							type="button"
							className={`gui-knowledge-nav-entry${section === s ? " gui-knowledge-nav-entry--active" : ""}`}
							onClick={() => setSection(s)}
						>
							<Icon name={SECTION_ICONS[s]} className="h-3.5 w-3.5 flex-shrink-0" />
							<span className="gui-knowledge-nav-label">{SECTION_LABEL[s]}</span>
							<span className="gui-knowledge-nav-count">{counts[s]}</span>
						</button>
					))}
				</nav>
			</div>
		</div>
	);
}
