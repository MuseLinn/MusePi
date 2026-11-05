/**
 * Plugin surfaces: the real chat page, file workspace and right-panel shell.
 *
 * In production the daemon compiles these slot components and ships them inside
 * `extensions.list`; the demo serves modules compiled from the same sources by
 * `build-web-demo.mjs`. The renderer blob-imports each `code` and mounts it into
 * its slot, so only the transport is fake here.
 *
 * The manifest carries slot/label/availability straight from the plugins' own
 * `registerComponent` calls, so this module never restates them.
 */

import { methods as shell } from "./shell.js";

const base = shell["extensions.list"];

let loaded = null;

async function text(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url} responded ${response.status}`);
	return await response.text();
}

function loadComponents() {
	loaded ??= (async () => {
		const manifest = JSON.parse(await text("./plugins/manifest.json"));
		return await Promise.all(
			manifest.components.map(async item => {
				const [code, css] = await Promise.all([
					text(`./plugins/${item.code}`),
					item.css ? text(`./plugins/${item.css}`) : Promise.resolve(undefined),
				]);
				return {
					slot: item.slot,
					extensionId: item.extensionId,
					label: item.label,
					...(item.order !== undefined ? { order: item.order } : {}),
					...(item.availability ? { availability: item.availability } : {}),
					code,
					...(css ? { css } : {}),
				};
			}),
		);
	})();
	return loaded;
}

export const methods = {
	"extensions.list": async () => ({ ...base(), components: await loadComponents() }),
};
