import { type ReactNode, useEffect, useRef, useState } from "react";

function serialize(rows: readonly string[]): string[] {
	return rows.map(row => row.trim()).filter(Boolean);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Free-form string array (`ui.item: "string"`, the default): one row per
 * value, add and remove without ever joining on commas.
 *
 * A comma-separated field cannot represent a value that contains a comma —
 * shell minimizer rules, command lines, regex-ish patterns — and gave no way
 * to delete a single entry. Rows here are the values, so each edit is local and
 * reversible.
 */
export function TextListEditor({
	values,
	onChange,
	placeholder,
	emptyHint,
	addLabel,
	removeLabel,
	disabled = false,
	ariaLabel,
}: {
	values: readonly string[];
	onChange(next: string[]): void;
	placeholder?: string;
	emptyHint?: string;
	addLabel: string;
	removeLabel: string;
	disabled?: boolean;
	ariaLabel?: string;
}): ReactNode {
	const [rows, setRows] = useState<string[]>(() => [...values]);
	const [focusIndex, setFocusIndex] = useState<number | null>(null);

	// Follow external writes without clobbering the row the user is typing
	// in: a local list that already matches (our own commit echoed back) is
	// left alone.
	useEffect(() => {
		setRows(previous => (sameList(previous, values) ? previous : [...values]));
	}, [values]);

	const commit = (next: string[]): void => {
		setRows(next);
		const stored = serialize(next);
		if (!sameList(stored, serialize(values))) onChange(stored);
	};

	const settle = (index: number): void => {
		const row = rows[index];
		if (row === undefined) return;
		if (row.trim() === "") {
			commit(rows.filter((_, position) => position !== index));
			return;
		}
		if (row !== row.trim()) commit(rows.map((item, position) => (position === index ? item.trim() : item)));
	};

	return (
		<div className="gui-list-editor" role="group" aria-label={ariaLabel}>
			{rows.length === 0 && emptyHint !== undefined && <p className="gui-list-empty">{emptyHint}</p>}
			{rows.map((row, index) => (
				<div className="gui-list-row" key={index}>
					<input
						className="gui-list-input"
						value={row}
						placeholder={placeholder}
						disabled={disabled}
						autoFocus={focusIndex === index}
						onChange={event =>
							setRows(previous =>
								previous.map((item, position) => (position === index ? event.target.value : item)),
							)
						}
						onBlur={() => settle(index)}
						onKeyDown={event => {
							if (event.key === "Enter") {
								event.preventDefault();
								settle(index);
								event.currentTarget.blur();
							}
						}}
					/>
					<button
						type="button"
						className="gui-list-remove"
						title={removeLabel}
						aria-label={removeLabel}
						disabled={disabled}
						onClick={() => commit(rows.filter((_, position) => position !== index))}
					>
						✕
					</button>
				</div>
			))}
			<button
				type="button"
				className="gui-list-add"
				disabled={disabled}
				onClick={() => {
					setRows(previous => [...previous, ""]);
					setFocusIndex(rows.length);
				}}
			>
				<span aria-hidden>+</span>
				{addLabel}
			</button>
		</div>
	);
}

/**
 * Object array (`ui.item: "record"`, e.g. `bash.patterns`,
 * `prompt.sections`): a JSON list, because each element is a typed record and
 * a string row list would store garbage. Invalid JSON stays local with an
 * inline error and never reaches `settings.set`.
 */
export function JsonListEditor({
	value,
	onChange,
	invalidLabel,
	emptyHint,
	disabled = false,
	ariaLabel,
}: {
	value: unknown;
	onChange(next: unknown[]): void;
	invalidLabel: string;
	emptyHint?: string;
	disabled?: boolean;
	ariaLabel?: string;
}): ReactNode {
	const stored = Array.isArray(value) ? value : [];
	const [text, setText] = useState(() => JSON.stringify(stored, null, 2));
	const [invalid, setInvalid] = useState(false);
	const external = JSON.stringify(stored, null, 2);
	const focused = useRef(false);

	useEffect(() => {
		if (!focused.current) setText(external);
	}, [external]);

	const commit = (): void => {
		const trimmed = text.trim();
		if (trimmed === "") {
			if (stored.length > 0) onChange([]);
			setText("[]");
			setInvalid(false);
			return;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (!Array.isArray(parsed)) {
				setInvalid(true);
				return;
			}
			setInvalid(false);
			setText(JSON.stringify(parsed, null, 2));
			if (JSON.stringify(parsed) !== JSON.stringify(stored)) onChange(parsed);
		} catch {
			setInvalid(true);
		}
	};

	const lines = text.split("\n").length;

	return (
		<div className="gui-list-editor">
			<textarea
				className="gui-list-json"
				spellCheck={false}
				value={text}
				rows={Math.min(16, Math.max(3, lines))}
				disabled={disabled}
				aria-label={ariaLabel}
				placeholder={'[\n  { "match": "rm -rf *", "approval": "deny" }\n]'}
				onFocus={() => {
					focused.current = true;
				}}
				onChange={event => {
					setText(event.target.value);
					setInvalid(false);
				}}
				onBlur={() => {
					focused.current = false;
					commit();
				}}
			/>
			{invalid && (
				<span className="gui-list-invalid" role="alert">
					{invalidLabel}
				</span>
			)}
			{stored.length === 0 && emptyHint !== undefined && <p className="gui-list-empty">{emptyHint}</p>}
		</div>
	);
}
