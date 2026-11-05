import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getLocaleSnapshot, setLocale } from "../src/i18n/index.js";
import { askRenderer } from "../src/tool-render/tools/ask";
import type { ToolRenderProps } from "../src/tool-render/types";

const Summary = askRenderer.Summary as (props: ToolRenderProps) => ReactNode;
const Body = askRenderer.Body as (props: ToolRenderProps) => ReactNode;

const INITIAL_LOCALE = getLocaleSnapshot();
beforeAll(() => setLocale("en-US"));
afterAll(() => setLocale(INITIAL_LOCALE));

const ARGS = {
	background: true,
	questions: [
		{ id: "db", question: "Which database?", options: [{ label: "SQLite" }, { label: "Postgres" }] },
		{ id: "auth", question: "Which auth method?", options: [{ label: "JWT" }, { label: "Sessions" }] },
	],
};

/** The tool result the background path returns before the user answers. */
const PENDING_RESULT = {
	content: [
		{
			type: "text",
			text: "Started background question job-1. Continue with other work; the answer arrives automatically in a later turn.",
		},
	],
	details: { background: true, taskId: "job-1" },
};

function render(component: typeof Summary, props: ToolRenderProps): string {
	return renderToStaticMarkup(component(props) as React.ReactElement);
}

describe("ask renderer — background questions", () => {
	it("collapses a waiting background ask to count + task id", () => {
		const html = render(Summary, { name: "ask", args: ARGS, result: PENDING_RESULT } as ToolRenderProps);
		expect(html).toContain("2 question(s)");
		expect(html).toContain("Job job-1");
		// Header only: the question text belongs to the body, which stays closed.
		expect(html).not.toContain("Which database?");
	});

	it("keeps a streaming background call on the same one-line header", () => {
		const html = render(Summary, { name: "ask", args: ARGS, result: undefined, running: true } as ToolRenderProps);
		expect(html).toContain("2 question(s)");
		expect(html).not.toContain("Job ");
	});

	it("does not expand questions or options while the answer is pending", () => {
		const html = render(Body, { name: "ask", args: ARGS, result: PENDING_RESULT } as ToolRenderProps);
		expect(html).toBe("");
	});

	it("renders the ordinary Q&A once a result carries answers", () => {
		const answered = {
			content: [{ type: "text", text: "Answered" }],
			details: {
				results: [
					{
						id: "db",
						question: "Which database?",
						options: ["SQLite", "Postgres"],
						multi: false,
						selectedOptions: ["Postgres"],
					},
					{
						id: "auth",
						question: "Which auth method?",
						options: ["JWT", "Sessions"],
						multi: false,
						selectedOptions: ["JWT"],
					},
				],
			},
		};
		const summary = render(Summary, { name: "ask", args: ARGS, result: answered } as ToolRenderProps);
		// The settled card is a normal ask again: first question, no task chip.
		expect(summary).toContain("Which database?");
		expect(summary).not.toContain("Job job-1");

		const body = render(Body, { name: "ask", args: ARGS, result: answered } as ToolRenderProps);
		expect(body).toContain("Which database?");
		expect(body).toContain("Which auth method?");
		expect(body).toContain("●");
		expect(body).toContain("Postgres");
	});

	it("leaves non-background asks untouched", () => {
		const result = { content: [], details: { results: [] } };
		const summary = render(Summary, {
			name: "ask",
			args: { questions: ARGS.questions.slice(0, 1) },
			result,
		} as ToolRenderProps);
		expect(summary).toContain("Which database?");
		expect(summary).not.toContain("Job ");
	});

	it("shows the failure text instead of collapsing an errored background call", () => {
		const errored = {
			content: [{ type: "text", text: "The user did not answer the background question." }],
			isError: true,
			details: { background: true, taskId: "job-1" },
		};
		const body = render(Body, { name: "ask", args: ARGS, result: errored } as ToolRenderProps);
		expect(body).toContain("The user did not answer the background question.");
	});
});
