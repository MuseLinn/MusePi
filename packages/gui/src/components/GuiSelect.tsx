import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useFloatingMenu } from "../lib/use-floating-menu";

/**
 * GuiSelect — frosted dropdown replacing the native <select> (whose option
 * list is system chrome, "毛坯" next to the glass menus). Thin adapter
 * over {@link useFloatingMenu}, the single floating-menu implementation:
 * portal + positioning + two-phase transform-only enter + outside-click /
 * Escape close + the global menu mutex. The trigger keeps the
 * settings-select look; keyboard: Enter/↑/↓ open, ↑/↓ move, Enter
 * commits, Escape closes. Two options render as a segmented toggle.
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
	const [highlight, setHighlight] = useState(0);
	const btnRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const { renderMenu } = useFloatingMenu(open, setOpen, {
		className: "gui-select-menu",
		anchor: btnRef.current,
	});

	const label = options.find(o => o.value === value)?.label ?? String(value);

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

	const commit = (opt: SelectOption<T>): void => {
		onChange(opt.value);
		setOpen(false);
	};

	// Keyboard navigation on the open listbox: ↑/↓ move the highlight,
	// Enter commits the highlighted option. Opening happens on the trigger
	// (Enter/↑/↓ via its onKeyDown); Escape closes via useFloatingMenu.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent): void => {
			const t = e.target as Node | null;
			// Navigation applies while focus is on the trigger OR inside the
			// listbox (opening via keyboard leaves focus on the trigger).
			if (t && !listRef.current?.contains(t) && !btnRef.current?.contains(t)) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlight(h => (h + 1) % options.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlight(h => (h - 1 + options.length) % options.length);
			} else if (e.key === "Enter") {
				e.preventDefault();
				const opt = options[highlight];
				if (opt) commit(opt);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, highlight, options]);

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
				onClick={() => setOpen(v => !v)}
				onKeyDown={e => {
					if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp")) {
						e.preventDefault();
						setOpen(true);
					}
				}}
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
			{renderMenu(
				<div
					ref={listRef}
					role="listbox"
					aria-label={ariaLabel}
					style={{ minWidth: `${Math.max(btnRef.current?.getBoundingClientRect().width ?? 190, 190)}px` }}
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
			)}
		</>
	);
}
