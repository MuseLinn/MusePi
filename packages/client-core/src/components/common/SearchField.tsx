import { Search } from "lucide-react";
import type { CompositionEventHandler, KeyboardEventHandler, ReactNode, Ref } from "react";
import "./SearchField.css";

/**
 * One search field for every list filter in the product.
 *
 * The desktop settings, the capability tool rows and the shared marketplace
 * grid each used to hand-roll their own wrapper: four different heights, three
 * fills, two radii, and some with no magnifier at all (the connectors page was
 * a bare `gui-input`). They now share this component and the `--control-*`
 * tokens in `tokens.css`, so a search field reads as the same object wherever
 * it appears — and the geometry exists once.
 *
 * `size="compact"` is for narrow columns (settings sidebar, menus, sheets)
 * where a 34px row would crowd the list; only the height shrinks, the surface
 * stays identical. Layout (flex sizing, margins) belongs to `className`;
 * `inputClassName` exists only for hosts that keep a test hook on the input.
 */
export interface SearchFieldProps {
	value: string;
	onChange(value: string): void;
	placeholder: string;
	ariaLabel?: string;
	/** Layout class for the wrapper (flex sizing, margins). */
	className?: string;
	/** Styling/test hook for the `<input>` itself. */
	inputClassName?: string;
	size?: "field" | "compact" | "touch";
	iconSize?: number;
	trailing?: ReactNode;
	disabled?: boolean;
	autoFocus?: boolean;
	inputRef?: Ref<HTMLInputElement>;
	spellCheck?: boolean;
	enterKeyHint?: "search" | "send" | "done";
	onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
	onCompositionStart?: CompositionEventHandler<HTMLInputElement>;
	onCompositionEnd?: CompositionEventHandler<HTMLInputElement>;
}

export function SearchField({
	value,
	onChange,
	placeholder,
	ariaLabel,
	className,
	inputClassName,
	size = "field",
	iconSize = 14,
	trailing,
	disabled,
	autoFocus,
	inputRef,
	spellCheck,
	enterKeyHint,
	onKeyDown,
	onCompositionStart,
	onCompositionEnd,
}: SearchFieldProps): ReactNode {
	return (
		<label
			className={`gui-search${size === "field" ? "" : ` gui-search--${size}`}${disabled ? " gui-search--disabled" : ""}${className ? ` ${className}` : ""}`}
		>
			<Search size={iconSize} strokeWidth={2} aria-hidden="true" className="gui-search-icon" />
			<input
				ref={inputRef}
				type="search"
				className={`gui-search-input${inputClassName ? ` ${inputClassName}` : ""}`}
				value={value}
				placeholder={placeholder}
				aria-label={ariaLabel ?? placeholder}
				disabled={disabled}
				autoFocus={autoFocus}
				spellCheck={spellCheck}
				enterKeyHint={enterKeyHint}
				onChange={event => onChange(event.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
			/>
			{trailing}
		</label>
	);
}
