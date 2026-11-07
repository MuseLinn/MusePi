/**
 * When to reach for the `widget` tool — ONE text, two readers.
 *
 * The tool description alone was not enough: asked for a breakdown of lines
 * of code per package, an agent answered with a list and drew the chart only
 * when asked. Interface mockups are named on their own because listing them
 * only as data made a literal model read the rule as "charts only", while a
 * proposed UI change is where a page helps most. The limits matter as much as
 * the cases: a page for two numbers is worse than a sentence.
 *
 * Both the tool description (`visuals/prompt.md`) and the SYSTEM PROMPT
 * (`prompts/system/system-prompt.md`) render this constant. Keeping them on
 * one string is the point — two copies drift, and the one that drifts is the
 * one the model actually reads.
 */

export const WIDGET_RENDER_WHEN =
	"Use it proactively — do not wait for the user to ask for a visualization — when the answer is mostly data or structure the user would otherwise have to picture:" +
	" numbers compared across several items (sizes, counts, timings, costs, test or benchmark results)," +
	" a breakdown or share of a whole, a trend over time, options compared on several criteria," +
	" a timeline of events, or how components connect." +
	" Use it too when the answer is about how something looks: a proposed interface change shown as it would appear," +
	" before and after side by side, or layout options to choose between." +
	" Do not use it for a few numbers or a short list that reads fine as text, for code, or when the user asked for plain text." +
	" At most one page per answer." +
	" Keep the explanation in the response; never restate what the widget already shows.";
