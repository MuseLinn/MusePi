import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../installer/ui/installer-locales.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const { locales, selectors, normalise, apply } = context.MusePiInstallerI18n;

assert.deepEqual(Object.keys(locales).sort(), ["en-US", "zh-CN", "zh-TW"]);
const englishKeys = Object.keys(locales["en-US"]).sort();
for (const language of ["zh-CN", "zh-TW"]) {
	assert.deepEqual(Object.keys(locales[language]).sort(), englishKeys, `${language} must not fall back for missing keys`);
}
assert.equal(normalise("zh-TW"), "zh-TW");
assert.equal(normalise("zh-Hant"), "en-US");

function documentFixture() {
	const nodes = new Map();
	return {
		documentElement: { lang: "" },
		title: "",
		querySelector(selector) {
			if (!nodes.has(selector)) {
				nodes.set(selector, {
					tagName: "DIV",
					textContent: "",
					attributes: {},
					setAttribute(name, value) { this.attributes[name] = value; },
				});
			}
			return nodes.get(selector);
		},
		nodes,
	};
}

const doc = documentFixture();
apply("zh-TW", doc);
assert.equal(doc.documentElement.lang, "zh-TW");
assert.equal(doc.title, "MusePi 安裝程式");
assert.equal(doc.nodes.get(selectors.languageTitle).textContent, "選擇語言");
assert.equal(doc.nodes.get(selectors.continue).textContent, "繼續");
assert.equal(doc.nodes.get(selectors.locationTitle).textContent, "選擇安裝位置");
assert.equal(doc.nodes.get(selectors.install).textContent, "安裝");
assert.equal(doc.nodes.get("#btn-close").attributes["aria-label"], "關閉");
for (const selector of Object.values(selectors)) {
	assert.ok(doc.nodes.get(selector).textContent.length > 0, `${selector} must have localized text`);
}

apply("en-US", doc);
assert.equal(doc.nodes.get(selectors.languageTitle).textContent, "Choose a language");
apply("zh-CN", doc);
assert.equal(doc.nodes.get(selectors.languageTitle).textContent, "选择语言");

console.log("installer locale tests: PASS");
