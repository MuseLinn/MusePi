import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * GuiSelect — frosted dropdown replacing the native <select> (whose option
 * list is system chrome, "毛坯" next to the glass menus). The trigger keeps
 * the settings-select look; the list is a portal-rendered frosted menu
 * (gui-select-pop styles), same blur/shadow tier as gui-context-menu.
 * Outside click / Escape / scroll-away close it. Keyboard: Enter opens,
 * arrows move, Enter commits (minimal but functional).
 */

export interface SelectOption<T extends string> {
	value: T;
	label: string;
}

export function GuiSelect<T extends string>({
	value,
	onChange,
	options,
	className,
	ariaLabel,
	disabled,
}: {
	value: T;
	onChange(v: T): void;
	options: SelectOption<T>[];
	className?: string;
	ariaLabel?: string;
	disabled?: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [entered, setEntered] = useState(false);
	const [closing, setClosing] = useState(false);
	const [anchor, setAnchor] = useState<{ x: number; y: number; w: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [highlight, setHighlight] = useState(0);
	// Exit timer handle — re-opening inside the 140ms closing window must
	// cancel it, otherwise the stale timer resets `entered` on the fresh
	// menu and the listbox stays at opacity 0 (invisible but "open").
	const closeTimerRef = useRef<number | null>(null);

	const label = options.find(o => o.value === value)?.label ?? String(value);

	// Two-phase enter (frosted backdrop composites before the scale).
	useEffect(() => {
		if (!open) return;
		const raf = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
		return () => cancelAnimationFrame(raf);
	}, [open]);

	const close = (): void => {
		if (!open) return;
		setClosing(true);
		setOpen(false);
		if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			setClosing(false);
			setEntered(false);
			closeTimerRef.current = null;
		}, 140);
	};

	useEffect(() => {
		if (!open) return;
		const btn = btnRef.current;
		if (btn) {
			const r = btn.getBoundingClientRect();
			setAnchor({ x: r.left, y: r.bottom, w: r.width });
		}
		setHighlight(
			Math.max(
				0,
				options.findIndex(o => o.value === value),
			),
		);
	}, [open, options, value]);

	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent | KeyboardEvent): void => {
			if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
			const t = e.target as Node | null;
			if (!(t instanceof Node)) return;
			// The trigger toggles via its own onClick — a mousedown here
			// must NOT close (it runs before the click and would fight the
			// toggle, leaving the menu in a half-open state).
			if (btnRef.current?.contains(t)) return;
			if (listRef.current?.contains(t)) return;
			close();
		};
		const onScroll = (): void => close();
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onDoc);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onDoc);
			window.removeEventListener("scroll", onScroll, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const commit = (opt: SelectOption<T>): void => {
		onChange(opt.value);
		close();
	};

	// Two options → a segmented toggle instead of a dropdown (the listbox
	// chrome is overkill for a binary choice; the trigger width was the
	// only constraint — inline segments read fine beside the label). Three
	// or more options keep the list. Reuses the existing .gui-segmented
	// visual language (ZCode appearance settings).
	if (options.length === 2) {
		return (
			<div className={`gui-segmented${className ? ` ${className}` : ""}`} role="group" aria-label={ariaLabel}>
				{options.map(o => (
					<button
						type="button"
						key={o.value}
						role="tab"
						aria-selected={o.value === value}
						className={`gui-seg-btn${o.value === value ? " gui-seg-btn--active" : ""}`}
						onClick={() => onChange(o.value)}
					>
						{o.label}
					</button>
				))}
			</div>
		);
	}

	return (
		<>
			<button
				ref={btnRef}
				type="button"
				disabled={disabled}
				className={`gui-select-trigger${className ? ` ${className}` : ""}`}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => (open ? close() : setOpen(true))}
			>
				<span className="min-w-0 flex-1 truncate text-left">{label}</span>
				<svg viewBox="0 0 16 16" className="gui-select-chev" aria-hidden="true">
					<path
						d="M4.5 6.5 8 10l3.5-3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open &&
				createPortal(
					<div
						ref={listRef}
						role="listbox"
						className={`gui-select-pop${entered ? " gui-select-pop--entered" : ""}${closing ? " gui-menu-popup--closing" : ""}`}
						style={
							anchor
								? {
										left: `${Math.min(anchor.x, window.innerWidth - 220)}px`,
										top: `${anchor.y + 6}px`,
										minWidth: `${Math.max(anchor.w, 190)}px`,
									}
								: undefined
						}
					>
						{options.map((opt, i) => (
							<button
								type="button"
								key={opt.value}
								role="option"
								aria-selected={opt.value === value}
								className={`gui-select-opt${opt.value === value ? " gui-select-opt--sel" : ""}${i === highlight ? " gui-select-opt--hl" : ""}`}
								onMouseEnter={() => setHighlight(i)}
								onClick={() => commit(opt)}
							>
								<span className="min-w-0 flex-1 truncate">{opt.label}</span>
								{opt.value === value && (
									<svg viewBox="0 0 16 16" className="gui-select-check" aria-hidden="true">
										<path
											d="m3.5 8.5 3 3 6-7"
											fill="none"
											stroke="currentColor"
											strokeWidth="1.8"
											strokeLinecap="round"
											strokeLinejoin="round"
										/>
									</svg>
								)}
							</button>
						))}
					</div>,
					document.body,
				)}
		</>
	);
}
