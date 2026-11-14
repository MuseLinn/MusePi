import "./happy-dom-shim";
import { beforeEach, expect, test } from "bun:test";
import { onGitPrefsChanged, readChangesView, writeChangesView } from "../src/lib/git-prefs";

beforeEach(() => {
	window.localStorage.clear();
});

test("changes view is one key and notifies live consumers", () => {
	const seen: string[] = [];
	const off = onGitPrefsChanged(() => seen.push(readChangesView()));
	writeChangesView("tree");
	expect(readChangesView()).toBe("tree");
	expect(seen).toEqual(["tree"]);
	writeChangesView("flat");
	expect(readChangesView()).toBe("flat");
	expect(seen).toEqual(["tree", "flat"]);
	off();
});
