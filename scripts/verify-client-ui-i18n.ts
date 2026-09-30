/**
 * verify-client-ui-i18n — 拒绝产品文案硬编码进 GUI 源码（dsh
 * `scripts/verify-client-ui-i18n.ts` 的移植，校验哲学一致）：
 *
 * locale 词典（client-core/src/i18n 域文件）是唯一直接持有译文的源文件；
 * 展示代码只能经 `t()` 或已本地化的 prop 获得文案。本门禁 AST 扫描 JSX
 * 文本、文案承载属性（label/placeholder/aria-label/…）、文案命名的变量/
 * 属性/返回值，把硬编码中文/英文句子钉在 CI 必经路径（root check:tools）。
 *
 * AST 层用 @babel/parser（仓库既有依赖；typescript@7 仅暴露 tsgo 编译器
 * 外壳，不导出编译器 API，与 dsh 用 typescript 包不同）。
 *
 * 存量债用 ratchet 基线收口：baseline JSON 记录每个文件当前的违规数，
 * 只能减不能增（`--update` 在刻意清债后重新生成）；未登记文件零配额——
 * 第一行硬编码文案即红。这与 verify-translation-pairing 的渐进落地同哲学。
 *
 * 用法：`bun scripts/verify-client-ui-i18n.ts`（检查）/
 *       `bun scripts/verify-client-ui-i18n.ts --update`（清债后重建基线）。
 */
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseBabel } from "@babel/parser";
import type * as Babel from "@babel/types";

const root = resolve(import.meta.dirname, "..");
const BASELINE_PATH = resolve(import.meta.dirname, "verify-client-ui-i18n-baseline.json");
const MINIMUM_CLIENT_UI_SOURCES = 100;

const COPY_ATTRIBUTES = new Set([
	"alt",
	"aria-description",
	"aria-label",
	"aria-valuetext",
	"cancelLabel",
	"closeLabel",
	"confirmLabel",
	"copyLabel",
	"description",
	"emptyLabel",
	"label",
	"placeholder",
	"title",
	"truncatedLabel",
]);
const COPY_ATTRIBUTE_SUFFIX = /(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/;

const COPY_NAME =
	/(?:^|_)(?:aria|copy|description|empty|heading|label|message|placeholder|summary|text|title|tooltip)(?:s|_.*)?$/i;
const COPY_SUFFIX =
	/(?:aria|copy|description|empty|heading|label|labels|message|placeholder|summary|text|title|tooltip|tabs)$/i;
const IMMUTABLE_LANGUAGE_TOKENS = new Set([
	"B",
	"Function",
	"GB",
	"K",
	"KB",
	"M",
	"MB",
	"Symbol",
	"false",
	"function()",
	"n",
	"null",
	"true",
	"undefined",
]);
const LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/;

/** One hard-coded product-copy occurrence. */
export interface UiI18nViolation {
	/** One-based source column. */
	column: number;
	/** Repository-relative source path. */
	file: string;
	/** One-based source line. */
	line: number;
	/** Why this literal is treated as product copy. */
	reason: string;
	/** Compact literal text for the diagnostic. */
	text: string;
}

function localeOwner(file: string): boolean {
	const normalized = file.replaceAll("\\", "/");
	return normalized.includes("/src/i18n/");
}

function excluded(file: string): boolean {
	const normalized = file.replaceAll("\\", "/");
	return localeOwner(normalized) || normalized.includes("/src/vendor/");
}

function containsProductText(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim();
	// A lone non-CJK glyph ("v" version prefix, "×", "…") is a symbol, not copy.
	if (Array.from(normalized).length === 1 && !/[\u3400-\u9fff]/u.test(normalized)) return false;
	return (
		normalized !== "" &&
		!IMMUTABLE_LANGUAGE_TOKENS.has(normalized) &&
		!LOCALE_KEY.test(normalized) &&
		/\p{L}/u.test(normalized)
	);
}

function copyAttribute(name: string): boolean {
	return !name.endsWith("Key") && (COPY_ATTRIBUTES.has(name) || COPY_ATTRIBUTE_SUFFIX.test(name));
}

function compactText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function looksLikeNaturalText(text: string): boolean {
	const normalized = text.replace(/\s+/g, " ").trim();
	return /\s|[\u3400-\u9fff]/u.test(normalized) || /^[A-Z]/.test(normalized);
}

function babelPropName(key: Babel.ObjectProperty["key"]): string | undefined {
	if (key.type === "Identifier") return key.name;
	if (key.type === "StringLiteral") return key.value;
	return undefined;
}

type BabelNode = Babel.Node;

/**
 * Find hard-coded product copy in one Client source file.
 * @param file - repository-relative path used in diagnostics.
 * @param sourceText - TypeScript or TSX source.
 * @returns violations in source order.
 */
export function findUiI18nViolations(file: string, sourceText: string): UiI18nViolation[] {
	if (localeOwner(file)) return [];
	const isTsx = file.endsWith(".tsx");
	const ast = parseBabel(sourceText, {
		sourceType: "module",
		plugins: isTsx ? (["typescript", "jsx"] as const) : (["typescript"] as const),
		errorRecovery: true,
	});
	const violations = new Map<number, UiI18nViolation>();

	const report = (node: BabelNode, text: string, reason: string, naturalOnly = false): void => {
		if (
			!containsProductText(text) ||
			(naturalOnly && !looksLikeNaturalText(text)) ||
			(node.start !== null && violations.has(node.start))
		)
			return;
		violations.set(node.start ?? 0, {
			column: (node.loc?.start.column ?? 0) + 1,
			file,
			line: node.loc?.start.line ?? 0,
			reason,
			text: compactText(text),
		});
	};

	const collectExpression = (node: BabelNode | null | undefined, reason: string, naturalOnly = false): void => {
		if (node == null) return;
		switch (node.type) {
			case "StringLiteral":
				report(node, node.value, reason, naturalOnly);
				return;
			case "TemplateLiteral":
				report(node, node.quasis.map(q => q.value.raw).join(""), reason, naturalOnly);
				return;
			case "CallExpression":
			case "OptionalCallExpression":
			case "NewExpression":
				// A call result is dynamic; copy-bearing arguments are visited through their own syntax.
				return;
			case "TSAsExpression":
			case "TSSatisfiesExpression":
			case "TSTypeAssertion":
			case "TypeCastExpression":
			case "ParenthesizedExpression":
				collectExpression(node.expression, reason, naturalOnly);
				return;
			case "ConditionalExpression":
				collectExpression(node.consequent, reason, naturalOnly);
				collectExpression(node.alternate, reason, naturalOnly);
				return;
			case "LogicalExpression":
				if (node.operator === "&&") {
					collectExpression(node.right, reason, naturalOnly);
				} else {
					collectExpression(node.left, reason, naturalOnly);
					collectExpression(node.right, reason, naturalOnly);
				}
				return;
			case "BinaryExpression":
				if (node.operator === "+") {
					collectExpression(node.left, reason, naturalOnly);
					collectExpression(node.right, reason, naturalOnly);
				}
				return;
			case "ArrayExpression":
				for (const element of node.elements) collectExpression(element, reason, naturalOnly);
				return;
			case "ObjectExpression":
				for (const property of node.properties) {
					if (property.type !== "ObjectProperty") continue;
					const name = babelPropName(property.key);
					const propertyOwnsCopy = name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name));
					collectExpression(property.value as BabelNode, reason, naturalOnly || !propertyOwnsCopy);
				}
				return;
			default:
				return;
		}
	};

	const enclosingFunctionName = (ancestors: BabelNode[]): string | undefined => {
		for (let i = ancestors.length - 1; i >= 0; i--) {
			const current = ancestors[i];
			if (current.type === "FunctionDeclaration") return current.id?.name;
			if (current.type === "FunctionExpression") return undefined;
			if (current.type === "ObjectMethod" || current.type === "ClassMethod") {
				return current.key.type === "Identifier" ? current.key.name : undefined;
			}
			if (current.type === "ArrowFunctionExpression") {
				const parent = ancestors[i - 1];
				if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
				if (parent?.type === "AssignmentExpression" && parent.left.type === "Identifier") return parent.left.name;
				return undefined;
			}
		}
		return undefined;
	};

	const hasExplicitStringReturn = (ancestors: BabelNode[]): boolean => {
		for (let i = ancestors.length - 1; i >= 0; i--) {
			const current = ancestors[i];
			if (
				current.type === "FunctionDeclaration" ||
				current.type === "FunctionExpression" ||
				current.type === "ArrowFunctionExpression" ||
				current.type === "ObjectMethod" ||
				current.type === "ClassMethod"
			) {
				return (
					current.returnType?.type === "TSTypeAnnotation" &&
					current.returnType.typeAnnotation.type === "TSStringKeyword"
				);
			}
		}
		return false;
	};

	const visit = (node: BabelNode, ancestors: BabelNode[]): void => {
		switch (node.type) {
			case "JSXText":
				report(node, node.value, "JSX text");
				break;
			case "JSXAttribute": {
				const name = node.name.type === "JSXIdentifier" ? node.name.name : node.name.name;
				if (copyAttribute(name) && node.value != null) {
					if (node.value.type === "StringLiteral") report(node.value, node.value.value, `${name} attribute`);
					else if (node.value.type === "JSXExpressionContainer") {
						collectExpression(node.value.expression, `${name} attribute`);
					}
				}
				break;
			}
			case "JSXExpressionContainer": {
				const parent = ancestors[ancestors.length - 1];
				if (
					node.expression.type !== "JSXEmptyExpression" &&
					(parent?.type === "JSXElement" || parent?.type === "JSXFragment")
				) {
					collectExpression(node.expression, "JSX child");
				}
				break;
			}
			case "ObjectProperty": {
				if (!isTsx) break;
				const name = babelPropName(node.key);
				if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
					collectExpression(node.value as BabelNode, `${name} property`);
				}
				break;
			}
			case "VariableDeclarator": {
				const name = node.id.type === "Identifier" ? node.id.name : undefined;
				if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
					collectExpression(node.init, `${name} value`);
				}
				break;
			}
			case "AssignmentExpression": {
				const name = node.left.type === "Identifier" ? node.left.name : undefined;
				if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
					collectExpression(node.right, `${name} assignment`);
				}
				break;
			}
			case "ReturnStatement": {
				if (node.argument == null) break;
				const name = enclosingFunctionName(ancestors);
				if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
					collectExpression(node.argument, `${name} return value`);
				} else if (isTsx && hasExplicitStringReturn(ancestors)) {
					collectExpression(node.argument, "string return value", true);
				}
				break;
			}
			default:
				break;
		}
		const nextAncestors = [...ancestors, node];
		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
			const child = (node as unknown as Record<string, unknown>)[key];
			if (Array.isArray(child)) {
				for (const item of child) {
					if (item != null && typeof item === "object" && typeof (item as BabelNode).type === "string") {
						visit(item as BabelNode, nextAncestors);
					}
				}
			} else if (child != null && typeof child === "object" && typeof (child as BabelNode).type === "string") {
				visit(child as BabelNode, nextAncestors);
			}
		}
	};
	visit(ast.program, []);
	return [...violations.values()].sort((left, right) => left.line - right.line || left.column - right.column);
}

function sourceFiles(): string[] {
	return [
		...globSync("packages/desktop-app/src/**/*.{ts,tsx}", { cwd: root }),
		...globSync("packages/client-core/src/**/*.{ts,tsx}", { cwd: root }),
	]
		.map(file => file.replaceAll("\\", "/"))
		.filter(file => !file.endsWith(".d.ts") && !excluded(file))
		.sort();
}

type Baseline = Record<string, number>;

function loadBaseline(): Baseline {
	if (!existsSync(BASELINE_PATH)) return {};
	try {
		return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
	} catch {
		return {};
	}
}

function main(): void {
	const update = process.argv.includes("--update");
	const files = sourceFiles();
	if (files.length < MINIMUM_CLIENT_UI_SOURCES) {
		throw new Error(
			`verify-client-ui-i18n: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_CLIENT_UI_SOURCES}.`,
		);
	}
	const byFile = new Map<string, UiI18nViolation[]>();
	for (const file of files) {
		const violations = findUiI18nViolations(file, readFileSync(resolve(root, file), "utf8"));
		if (violations.length > 0) byFile.set(file, violations);
	}
	if (update) {
		const baseline: Baseline = {};
		for (const [file, list] of byFile) baseline[file] = list.length;
		writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
		console.log(`verify-client-ui-i18n: baseline updated — ${byFile.size} file(s) carry debt.`);
		return;
	}
	const baseline = loadBaseline();
	const regressions: string[] = [];
	const details: string[] = [];
	for (const [file, list] of byFile) {
		const allowed = baseline[file] ?? 0;
		if (list.length > allowed) {
			regressions.push(file);
			for (const v of list.slice(allowed)) {
				details.push(`  ${v.file}:${v.line}:${v.column} ${v.reason}: ${JSON.stringify(v.text)}`);
			}
		}
	}
	if (regressions.length > 0) {
		console.error(`verify-client-ui-i18n: ${regressions.length} file(s) exceed their hard-coded copy baseline:`);
		for (const line of details) console.error(line);
		console.error("Move the copy into a client-core i18n domain, or (if this is intentional debt) run:");
		console.error("  bun scripts/verify-client-ui-i18n.ts --update");
		process.exitCode = 1;
		return;
	}
	const totalDebt = Object.values(baseline).reduce((sum, n) => sum + n, 0);
	console.log(
		`verify-client-ui-i18n: ${files.length} Client UI source file(s) within baseline (${totalDebt} legacy violation(s) on record).`,
	);
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) main();
