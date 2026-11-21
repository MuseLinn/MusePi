/**
 * The component catalog an assistant writes UI blocks against.
 *
 * The language is OpenUI Lang, parsed by `@openuidev/lang-core`. Reusing the
 * established language matters more than any single feature: models already
 * know `name = Component(args)`, so a MusePi-specific format would be a dialect
 * every model has to relearn.
 *
 * The parser also supplies what a hand-rolled format cannot: a partial tree for
 * any prefix (a block grows while the reply streams), per-argument diagnostics
 * that name the component and the argument, and its tokenizer for the
 * `name: value` mistake models keep making in a positional language.
 *
 * The catalog is display-only. Form controls arrive with answer collection — a
 * `Choice` the host cannot send anywhere is worse than none, because the user
 * presses it and nothing happens.
 */

import { createLibrary, createParser, defineComponent, tokenize } from "@openuidev/lang-core";
import { z } from "zod";

export const UI_BLOCK_TONES = ["neutral", "info", "success", "warning", "error"] as const;

const tone = z.enum(UI_BLOCK_TONES);
const scalar = z.union([z.string(), z.number()]);

/** Signature order is object key order: it is the positional order the model writes. */
const Text = defineComponent({
	name: "Text",
	description: "Markdown; only bold and inline code are drawn, the rest is literal",
	props: z.object({ markdown: z.string() }),
	component: null,
});
const Badge = defineComponent({
	name: "Badge",
	description: "a short status word",
	props: z.object({ label: z.string(), tone: tone.optional() }),
	component: null,
});
const Callout = defineComponent({
	name: "Callout",
	description: "a note worth setting apart; only error/warning earns a filled box",
	props: z.object({ markdown: z.string(), tone: tone.optional(), title: z.string().optional() }),
	component: null,
});
const KeyValue = defineComponent({
	name: "KeyValue",
	description: "label/value pairs as two columns",
	props: z.object({ items: z.array(z.object({ label: z.string(), value: scalar })) }),
	component: null,
});
const Table = defineComponent({
	name: "Table",
	description: "draws as the chat's own table",
	props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(scalar)) }),
	component: null,
});
const Steps = defineComponent({
	name: "Steps",
	description: "a flow; direction column (default) or row",
	props: z.object({
		items: z.array(
			z.object({
				title: z.string(),
				markdown: z.string().optional(),
				status: z.enum(["done", "current", "todo", "blocked"]).optional(),
			}),
		),
		direction: z.enum(["column", "row"]).optional(),
	}),
	component: null,
});
const Stat = defineComponent({
	name: "Stat",
	description: "one key number with an optional delta",
	props: z.object({ label: z.string(), value: scalar, delta: z.string().optional(), tone: tone.optional() }),
	component: null,
});
const Progress = defineComponent({
	name: "Progress",
	description: "one value against a max (default 100)",
	props: z.object({ label: z.string(), value: z.number(), max: z.number().positive().optional() }),
	component: null,
});
const Series = defineComponent({
	name: "Series",
	description: "a chart's series; null breaks the line",
	props: z.object({ name: z.string(), values: z.array(z.number().nullable()) }),
	component: null,
});
const BarChart = defineComponent({
	name: "BarChart",
	description: "categories; whole: true only when the values are parts of one sum",
	props: z.object({
		labels: z.array(z.string()),
		series: z.array(Series.ref),
		unit: z.string().optional(),
		whole: z.boolean().optional(),
	}),
	component: null,
});
const LineChart = defineComponent({
	name: "LineChart",
	description: "values over time; at least two labels",
	props: z.object({ labels: z.array(z.string()), series: z.array(Series.ref), unit: z.string().optional() }),
	component: null,
});

const List = defineComponent({
	name: "List",
	description: "items one per line; `ordered` numbers them",
	props: z.object({ items: z.array(z.string()), ordered: z.boolean().optional() }),
	component: null,
});
const Quote = defineComponent({
	name: "Quote",
	description: "a quoted passage with an optional attribution",
	props: z.object({ markdown: z.string(), source: z.string().optional() }),
	component: null,
});
const Link = defineComponent({
	name: "Link",
	description:
		"one http(s) or mailto link; `description` says what it opens, `message` sends that sentence to the assistant when clicked",
	props: z.object({
		label: z.string(),
		href: z.string(),
		description: z.string().optional(),
		message: z.string().optional(),
	}),
	component: null,
});
const Icon = defineComponent({
	name: "Icon",
	description: "a small inline mark before a label; `label` is what a screen reader says",
	props: z.object({ name: z.string(), label: z.string().optional() }),
	component: null,
});
const Image = defineComponent({
	name: "Image",
	description:
		"a picture the reply is about; `src` is a local path the chat reads, or an http(s) URL; `alt` says what it shows",
	props: z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() }),
	component: null,
});
const Divider = defineComponent({
	name: "Divider",
	description: "a rule between two groups; `label` centres a short caption on it",
	props: z.object({ label: z.string().optional() }),
	component: null,
});
const Code = defineComponent({
	name: "Code",
	description: "a code block; `language` is a hint the chat prints as its label",
	props: z.object({ code: z.string(), language: z.string().optional(), title: z.string().optional() }),
	component: null,
});

const leaf = z.union([
	Text.ref,
	Badge.ref,
	Callout.ref,
	KeyValue.ref,
	Table.ref,
	Steps.ref,
	Stat.ref,
	Progress.ref,
	BarChart.ref,
	LineChart.ref,
	List.ref,
	Quote.ref,
	Link.ref,
	Icon.ref,
	Image.ref,
	Divider.ref,
	Code.ref,
]);

const Choice = defineComponent({
	name: "Choice",
	description:
		"name keys this answer: one option per line, `multiple` adds checkboxes; `layout` draws them as a list (default) or as one row of pills",
	props: z.object({
		name: z.string(),
		options: z.array(z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })])),
		label: z.string().optional(),
		multiple: z.boolean().optional(),
		layout: z.enum(["list", "row"]).optional(),
	}),
	component: null,
});
const Input = defineComponent({
	name: "Input",
	description: "name keys this answer; free text, `multiline` for a paragraph",
	props: z.object({
		name: z.string(),
		label: z.string().optional(),
		placeholder: z.string().optional(),
		multiline: z.boolean().optional(),
	}),
	component: null,
});
const Button = defineComponent({
	name: "Button",
	description:
		"value is the item it decides; put one Button per option inside a Card. Outside a Card every Button is its own decision, so give each one a `name`",
	props: z.object({
		label: z.string(),
		variant: z.enum(["primary", "secondary"]).optional(),
		value: z.string().optional(),
		name: z.string().optional(),
	}),
	component: null,
});

const DateInput = defineComponent({
	name: "DateInput",
	description: "name keys this answer: YYYY-MM-DD, or YYYY-MM-DDTHH:mm when `time`",
	props: z.object({
		name: z.string(),
		label: z.string().optional(),
		time: z.boolean().optional(),
		value: z.string().optional(),
	}),
	component: null,
});
const Slider = defineComponent({
	name: "Slider",
	description: "name keys this answer: a number between min and max; value is where it starts",
	props: z.object({
		name: z.string(),
		min: z.number(),
		max: z.number(),
		label: z.string().optional(),
		step: z.number().positive().optional(),
		value: z.number().optional(),
		unit: z.string().optional(),
	}),
	component: null,
});

/** What a reply asks with. A decision card holds buttons; a field asks directly. */
const ask = z.union([Choice.ref, Input.ref, Button.ref, DateInput.ref, Slider.ref]);

const Row = defineComponent({
	name: "Row",
	description: "side by side, wrapping",
	props: z.object({ children: z.array(z.union([leaf, ask])) }),
	component: null,
});
const Grid = defineComponent({
	name: "Grid",
	description: "equal columns for tiles (Stats, Cards); default 2",
	props: z.object({ children: z.array(z.union([leaf, ask, Row.ref])), columns: z.number().optional() }),
	component: null,
});
const Details = defineComponent({
	name: "Details",
	description: "a section folded under its title",
	props: z.object({ title: z.string(), children: z.array(z.union([leaf, ask, Row.ref])) }),
	component: null,
});
const Card = defineComponent({
	name: "Card",
	description: 'a titled group; title is inline Markdown, "" for none',
	props: z.object({ title: z.string(), children: z.array(z.union([leaf, ask, Row.ref, Grid.ref, Details.ref])) }),
	component: null,
});
const Tab = defineComponent({
	name: "Tab",
	description: "one page of a Tabs group; label is the short word on its tab",
	props: z.object({ label: z.string(), children: z.array(z.union([leaf, ask, Row.ref, Grid.ref, Details.ref])) }),
	component: null,
});
const Tabs = defineComponent({
	name: "Tabs",
	description: "one page shown at a time; only for views the reader switches between, never to hide the answer itself",
	props: z.object({ children: z.array(Tab.ref) }),
	component: null,
});
const Stack = defineComponent({
	name: "Stack",
	description: "the root: the whole block",
	props: z.object({
		children: z.array(z.union([leaf, ask, Row.ref, Grid.ref, Card.ref, Tabs.ref, Details.ref])),
	}),
	component: null,
});

export const uiBlockLibrary = createLibrary({
	components: [
		Text,
		Badge,
		Callout,
		KeyValue,
		Table,
		Steps,
		Stat,
		Progress,
		Series,
		BarChart,
		LineChart,
		List,
		Quote,
		Link,
		Icon,
		Image,
		Divider,
		Code,
		Choice,
		Input,
		DateInput,
		Slider,
		Button,
		Row,
		Grid,
		Details,
		Card,
		Tab,
		Tabs,
		Stack,
	],
	root: "Stack",
});

const parser = createParser(uiBlockLibrary.toJSONSchema(), "Stack");

export type UiBlockTree = {
	type: string;
	props: Record<string, unknown>;
	children: UiBlockTree[];
};

function isNode(value: unknown): value is { typeName?: string; props?: Record<string, unknown> } {
	return typeof value === "object" && value !== null && "typeName" in value;
}

function toTree(node: { typeName?: string; props?: Record<string, unknown> } | undefined): UiBlockTree | null {
	if (!node?.typeName) return null;
	const props: Record<string, unknown> = {};
	const children: UiBlockTree[] = [];
	for (const [key, raw] of Object.entries(node.props ?? {})) {
		// Only `children` is layout. A chart's `series` is data and stays in
		// props, where the chart renderer reads it.
		if (key === "children" && Array.isArray(raw)) {
			for (const item of raw) {
				const child = isNode(item) ? toTree(item) : null;
				if (child) children.push(child);
			}
			continue;
		}
		props[key] = raw;
	}
	return { type: node.typeName, props, children };
}

export interface UiBlockParse {
	tree: UiBlockTree | null;
	errors: string[];
	/** The source stopped mid-statement: a truncated stream, not a wrong program. */
	incomplete: boolean;
}

const tokenKind = (text: string): number => tokenize(text)[0]?.t ?? -1;
const NEWLINE = tokenKind(String.fromCharCode(10));
const CALL_OPEN = tokenKind("(");
const COMMA = tokenKind(",");
const COLON = tokenKind(":");
const IDENTIFIER = tokenKind("x");
const OPENERS = new Set([CALL_OPEN, tokenKind("["), tokenKind("{")]);
const CLOSERS = new Map([
	[tokenKind(")"), CALL_OPEN],
	[tokenKind("]"), tokenKind("[")],
	[tokenKind("}"), tokenKind("{")],
]);

/**
 * The `name:` a model writes inside a call, where the language takes positional
 * arguments. A key shifts every argument after it, so the parser's own errors
 * ("takes 4 arg(s), got 5", "undefined name") mislead; this scan replaces them
 * with the one thing the model must change. Object literals sit inside braces,
 * so they are not counted.
 */
function namedArgument(source: string): string | null {
	const tokens = tokenize(source).filter(token => token.t !== NEWLINE);
	const stack: number[] = [];
	let found: string | null = null;
	for (const [index, token] of tokens.entries()) {
		if (OPENERS.has(token.t)) {
			stack.push(token.t);
			continue;
		}
		const opener = CLOSERS.get(token.t);
		if (opener !== undefined) {
			if (stack.at(-1) === opener) stack.pop();
			continue;
		}
		if (token.t !== COLON || stack.at(-1) !== CALL_OPEN || tokens[index - 1]?.t !== IDENTIFIER) continue;
		const before = tokens[index - 2]?.t;
		if (before === CALL_OPEN || before === COMMA) found = String(tokens[index - 1]?.v ?? "");
	}
	return found === null ? null : `Named argument "${found}:" — arguments are positional, in signature order`;
}

/**
 * Parse one block. A block that cannot draw must say why: a silently empty
 * block reads as an app bug, while a named reason reads as the model's mistake
 * and can be fixed in the next turn.
 */
export function parseUiBlock(source: string): UiBlockParse {
	if (!source.trim()) return { tree: null, errors: ["The block needs root = Stack([...])"], incomplete: false };
	const result = parser.parse(source);
	const named = namedArgument(source);
	const errors = (named ? [] : result.meta.errors).map(
		error => `${[error.component, error.path].filter(Boolean).join(" ")}: ${error.message}`,
	);
	if (named) errors.unshift(named);
	else if (result.meta.unresolved.length) errors.push(`Undefined names: ${result.meta.unresolved.join(", ")}`);
	const incomplete = result.meta.incomplete;
	if (incomplete) errors.push("The block ends in the middle of a statement");
	// The parser reports the same cascade once per statement; a repeated reason
	// reads as several mistakes in the note and the repair message.
	const reasons = [...new Set(errors)];
	const tree = toTree(result.root ?? undefined);
	if (!tree) {
		return { tree: null, errors: reasons.length ? reasons : ["The block needs root = Stack([...])"], incomplete };
	}
	return { tree, errors: reasons, incomplete };
}

/** Every component name, for the guidance parity test. */
export const UI_BLOCK_TYPES = uiBlockLibrary.toSpec().components && Object.keys(uiBlockLibrary.toSpec().components);

/** Signatures generated from the catalog, so the guidance cannot drift from
 *  what the parser accepts. */
export function uiBlockSignatures(): string[] {
	return Object.values(uiBlockLibrary.toSpec().components).map(component => component.signature);
}
