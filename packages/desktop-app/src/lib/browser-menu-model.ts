import { managedTabIsBlank } from "./managed-browser-visibility";

export interface BrowserMenuModel {
	hasPage: boolean;
	canOpenExternal: boolean;
	actions: {
		find: boolean;
		print: boolean;
		zoom: boolean;
		deviceToolbar: boolean;
		focus: boolean;
		screenshot: boolean;
		copyUrl: boolean;
		openExternal: boolean;
		hardRefresh: boolean;
		downloads: boolean;
		history: boolean;
		clearData: boolean;
		settings: boolean;
	};
}

export function browserMenuModel(tab: { readonly url: string } | null): BrowserMenuModel {
	const hasPage = !managedTabIsBlank(tab);
	const canOpenExternal = hasPage && /^https?:\/\//i.test(tab?.url ?? "");
	return {
		hasPage,
		canOpenExternal,
		actions: {
			find: hasPage,
			print: hasPage,
			zoom: hasPage,
			deviceToolbar: hasPage,
			focus: hasPage,
			screenshot: hasPage,
			copyUrl: hasPage,
			openExternal: canOpenExternal,
			hardRefresh: hasPage,
			downloads: true,
			history: true,
			clearData: true,
			settings: true,
		},
	};
}
