import { Lexer, type Token, type Tokens } from "@musepi/pi-utils/marked";
import type * as Docx from "docx";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface InlineStyle {
	bold?: boolean;
	italics?: boolean;
	strike?: boolean;
	code?: boolean;
}

interface BlockContext {
	quote?: number;
	list?: { ordered: boolean; level: number; prefix: string };
}

/** Use a document filename, never a path, and keep Explorer downloads valid. */
export function markdownDocxName(name: string): string {
	const leaf = name.split(/[\\/]/).pop() ?? "";
	const withoutExtension = leaf.replace(/\.(?:md|markdown)$/i, "");
	const safe = withoutExtension.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
	return `${safe || "document"}.docx`;
}

/** Convert the shared Markdown token stream without maintaining an HTML
 * intermediate. The heavy docx package loads only when an export is requested. */
export async function markdownToDocxBlob(markdown: string): Promise<Blob> {
	const docx = await import("docx");
	return docx.Packer.toBlob(
		new docx.Document({
			creator: "MusePi",
			description: "Markdown exported from MusePi",
			sections: [{ children: blockChildren(docx, [...Lexer.lex(markdown)]) }],
		}),
	);
}

export async function downloadMarkdownDocx(markdown: string, name: string): Promise<void> {
	const blob = await markdownToDocxBlob(markdown);
	const url = URL.createObjectURL(new Blob([blob], { type: DOCX_MIME }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = markdownDocxName(name);
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	try {
		anchor.click();
	} finally {
		anchor.remove();
		// Revocation after the current task lets native download handling retain the URL.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

function blockChildren(docx: typeof Docx, tokens: Token[], context: BlockContext = {}): Docx.FileChild[] {
	const children: Docx.FileChild[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "heading":
				children.push(
					new docx.Paragraph({
						children: inlineChildren(docx, nestedTokens(token)),
						heading: headingLevel(docx, (token as Tokens.Heading).depth),
					}),
				);
				break;
			case "paragraph":
				children.push(
					new docx.Paragraph({
						children: [
							...(context.list ? [new docx.TextRun(context.list.prefix)] : []),
							...inlineChildren(docx, nestedTokens(token)),
						],
						...listProperties(context.list),
						...quoteProperties(docx, context.quote),
					}),
				);
				break;
			case "text":
				children.push(
					new docx.Paragraph({
						children: inlineChildren(docx, nestedTokens(token)),
						...listProperties(context.list),
						...quoteProperties(docx, context.quote),
					}),
				);
				break;
			case "code":
				for (const line of (token as Tokens.Code).text.split("\n")) {
					children.push(
						new docx.Paragraph({
							children: [new docx.TextRun({ text: line || " ", font: "Consolas", size: 20 })],
							shading: { fill: "F6F8FA" },
							spacing: { before: 0, after: 0 },
							...quoteProperties(docx, context.quote),
						}),
					);
				}
				break;
			case "blockquote":
				children.push(...blockChildren(docx, nestedTokens(token), { ...context, quote: (context.quote ?? 0) + 1 }));
				break;
			case "list": {
				const list = token as Tokens.List;
				const start = list.start === "" ? 1 : list.start;
				list.items.forEach((item, index) => {
					const prefix = item.task ? `${item.checked ? "☑" : "☐"} ` : list.ordered ? `${start + index}. ` : "";
					children.push(
						...blockChildren(docx, nestedTokens(item), {
							...context,
							list: { ordered: list.ordered, level: context.list?.level ?? 0, prefix },
						}),
					);
				});
				break;
			}
			case "table": {
				const table = token as Tokens.Table;
				children.push(
					new docx.Table({
						width: { size: 100, type: docx.WidthType.PERCENTAGE },
						rows: [table.header, ...table.rows].map((row, rowIndex) =>
							tableRow(docx, row, rowIndex === 0, table.align),
						),
					}),
				);
				break;
			}
			case "hr":
				children.push(
					new docx.Paragraph({
						border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: "D0D7DE", space: 1 } },
					}),
				);
				break;
			case "html":
				if ((token as Tokens.HTML).block) {
					const text = htmlText((token as Tokens.HTML).text);
					if (text) children.push(new docx.Paragraph(text));
				}
				break;
			case "space":
			case "def":
				break;
			default: {
				const nested = nestedTokens(token);
				if (nested.length > 0) children.push(...blockChildren(docx, nested, context));
				else if (token.raw.trim()) children.push(new docx.Paragraph(token.raw));
			}
		}
	}
	return children;
}

function inlineChildren(docx: typeof Docx, tokens: Token[], style: InlineStyle = {}): Docx.ParagraphChild[] {
	const children: Docx.ParagraphChild[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text":
			case "escape": {
				const nested = nestedTokens(token);
				if (nested.length > 0) children.push(...inlineChildren(docx, nested, style));
				else children.push(textRun(docx, (token as Tokens.Text | Tokens.Escape).text, style));
				break;
			}
			case "strong":
				children.push(...inlineChildren(docx, nestedTokens(token), { ...style, bold: true }));
				break;
			case "em":
				children.push(...inlineChildren(docx, nestedTokens(token), { ...style, italics: true }));
				break;
			case "del":
				children.push(...inlineChildren(docx, nestedTokens(token), { ...style, strike: true }));
				break;
			case "codespan":
				children.push(textRun(docx, (token as Tokens.Codespan).text, { ...style, code: true }));
				break;
			case "br":
				children.push(new docx.TextRun({ break: 1 }));
				break;
			case "link": {
				const link = token as Tokens.Link;
				const linked = inlineChildren(docx, nestedTokens(link), { ...style });
				if (/^(?:https?:|mailto:)/i.test(link.href)) {
					children.push(new docx.ExternalHyperlink({ children: linked, link: link.href }));
				} else {
					children.push(...linked);
				}
				break;
			}
			case "image": {
				const image = token as Tokens.Image;
				children.push(textRun(docx, image.text || image.href, { ...style, italics: true }));
				break;
			}
			case "html": {
				const text = htmlText((token as Tokens.HTML).text);
				if (text) children.push(textRun(docx, text, style));
				break;
			}
			case "checkbox":
				children.push(new docx.TextRun((token as Tokens.Checkbox).checked ? "☑ " : "☐ "));
				break;
			default: {
				const nested = nestedTokens(token);
				if (nested.length > 0) children.push(...inlineChildren(docx, nested, style));
				else if (token.type !== "space" && token.type !== "def") children.push(textRun(docx, token.raw, style));
			}
		}
	}
	return children;
}

function nestedTokens(token: Token | Tokens.TableCell): Token[] {
	return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function textRun(docx: typeof Docx, text: string, style: InlineStyle): Docx.TextRun {
	return new docx.TextRun({
		text,
		bold: style.bold,
		italics: style.italics,
		strike: style.strike,
		...(style.code ? { font: "Consolas", shading: { fill: "F6F8FA" } } : {}),
	});
}

function headingLevel(docx: typeof Docx, depth: number): Docx.IParagraphOptions["heading"] {
	const levels = [
		docx.HeadingLevel.HEADING_1,
		docx.HeadingLevel.HEADING_2,
		docx.HeadingLevel.HEADING_3,
		docx.HeadingLevel.HEADING_4,
		docx.HeadingLevel.HEADING_5,
		docx.HeadingLevel.HEADING_6,
	] as const;
	return levels[Math.max(0, Math.min(levels.length - 1, depth - 1))];
}

function listProperties(list: BlockContext["list"]): Pick<Docx.IParagraphOptions, "bullet" | "indent"> {
	if (!list) return {};
	return list.ordered
		? { indent: { left: 360 * (list.level + 1), hanging: 360 } }
		: { bullet: { level: Math.min(8, list.level) } };
}

function quoteProperties(docx: typeof Docx, quote: number | undefined): Partial<Docx.IParagraphOptions> {
	if (!quote) return {};
	return {
		indent: { left: 360 * quote },
		border: { left: { style: docx.BorderStyle.SINGLE, size: 12, color: "D0D7DE", space: 8 } },
	};
}

function tableRow(
	docx: typeof Docx,
	cells: Tokens.TableCell[],
	header: boolean,
	align: Tokens.Table["align"],
): Docx.TableRow {
	return new docx.TableRow({
		tableHeader: header,
		children: cells.map(
			(cell, index) =>
				new docx.TableCell({
					shading: header ? { fill: "F6F8FA" } : undefined,
					children: [
						new docx.Paragraph({
							children: inlineChildren(docx, nestedTokens(cell), header ? { bold: true } : {}),
							alignment: tableAlignment(docx, align[index]),
						}),
					],
				}),
		),
	});
}

function tableAlignment(
	docx: typeof Docx,
	align: Tokens.Table["align"][number] | undefined,
): Docx.IParagraphOptions["alignment"] {
	if (align === "center") return docx.AlignmentType.CENTER;
	if (align === "right") return docx.AlignmentType.RIGHT;
	return docx.AlignmentType.LEFT;
}

/** Raw HTML is not executed or fetched during export. Keep only visible text. */
function htmlText(html: string): string {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
