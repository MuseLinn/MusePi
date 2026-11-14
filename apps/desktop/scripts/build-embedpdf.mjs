import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const engineRequire = createRequire(require.resolve("@embedpdf/engines"));
const output = path.resolve(import.meta.dir, "../dist/embedpdf");

async function copy(source, target) {
	await Bun.write(target, Bun.file(source));
}

await copy(engineRequire.resolve("@embedpdf/pdfium/pdfium.wasm"), path.join(output, "pdfium.wasm"));

const fonts = [
	["@embedpdf/fonts-latin", "NotoSans-Regular.ttf"],
	["@embedpdf/fonts-sc", "NotoSansHans-Regular.otf"],
];
for (const [packageName, font] of fonts) {
	const entry = require.resolve(packageName);
	const root = path.resolve(path.dirname(entry), "..");
	await copy(path.join(root, "fonts", font), path.join(output, "fonts", font));
	const license = Bun.file(path.join(root, "LICENSE"));
	if (await license.exists()) await copy(license.name, path.join(output, `${packageName.split("/").at(-1)}-LICENSE`));
}
