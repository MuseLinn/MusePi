import "../../../test/happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { t } from "../../i18n/index.js";
import {
	type AddToChatDraftApi,
	type AddToChatFile,
	addFileToChat,
	addToChatUnavailableReason,
	registerAddToChatDraft,
	registerAddToChatFiles,
} from "./add-to-chat";

/** The bridge is the only thing the file menu calls; these fakes stand in for
 *  the composer (draft insertion) and the attachment intake (chip staging). */
function fakeComposer(options: { editable?: boolean } = {}): {
	draft: AddToChatDraftApi;
	files: { addWorkspaceFile(file: AddToChatFile): Promise<string | null> };
	inserted: string[];
	staged: AddToChatFile[];
	editable: { value: boolean };
} {
	const editable = { value: options.editable ?? true };
	const inserted: string[] = [];
	const staged: AddToChatFile[] = [];
	return {
		editable,
		inserted,
		staged,
		draft: {
			canInsert: () => editable.value,
			insertMention: label => inserted.push(label),
		},
		files: {
			addWorkspaceFile: async file => {
				staged.push(file);
				return "文件1";
			},
		},
	};
}

let disposeDraft: (() => void) | null = null;
let disposeFiles: (() => void) | null = null;
afterEach(() => {
	disposeDraft?.();
	disposeFiles?.();
	disposeDraft = null;
	disposeFiles = null;
});

function connect(composer: ReturnType<typeof fakeComposer>): void {
	disposeDraft = registerAddToChatDraft(composer.draft);
	disposeFiles = registerAddToChatFiles(composer.files);
}

describe("Add to chat availability", () => {
	test("no composer registered: the menu item is disabled with a reason", () => {
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
	});

	test("a file intake without a session draft is not enough", () => {
		disposeFiles = registerAddToChatFiles({ addWorkspaceFile: async () => null });
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
	});

	test("a disabled editor reports the reason instead of accepting the click", () => {
		const composer = fakeComposer({ editable: false });
		connect(composer);
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
	});

	test("both halves registered and editable: the item is live", () => {
		connect(fakeComposer());
		expect(addToChatUnavailableReason()).toBeNull();
	});
});

describe("addFileToChat", () => {
	test("stages the exact workspace path and inserts the chip's ordinal token", async () => {
		const composer = fakeComposer();
		connect(composer);
		const path = "/work/docs/a b[1].md";
		await expect(addFileToChat({ path, name: "a b[1].md", size: 12, isDir: false })).resolves.toBe(true);
		expect(composer.staged).toEqual([{ path, name: "a b[1].md", size: 12 }]);
		// The draft is the only thing touched: the token insertion is the whole
		// effect, and no send path is reachable from here.
		expect(composer.inserted).toEqual(["文件1"]);
	});

	test("a directory is never staged", async () => {
		const composer = fakeComposer();
		connect(composer);
		await expect(addFileToChat({ path: "/work/docs", name: "docs", isDir: true })).resolves.toBe(false);
		expect(composer.staged).toEqual([]);
		expect(composer.inserted).toEqual([]);
	});

	test("the draft is re-read after staging yields", async () => {
		const composer = fakeComposer();
		connect(composer);
		const original = composer.files.addWorkspaceFile;
		composer.files.addWorkspaceFile = async file => {
			const label = await original(file);
			composer.editable.value = false;
			return label;
		};
		await expect(addFileToChat({ path: "/work/a.md", name: "a.md", isDir: false })).resolves.toBe(false);
		expect(composer.inserted).toEqual([]);
	});

	test("a failed stage surfaces a notice naming the file", async () => {
		const composer = fakeComposer();
		connect(composer);
		composer.files.addWorkspaceFile = async () => null;
		const notices: string[] = [];
		const onToast = (event: Event): void => {
			notices.push(String((event as CustomEvent).detail));
		};
		window.addEventListener("musepi-gui-toast", onToast);
		try {
			await expect(addFileToChat({ path: "/work/a.md", name: "a.md", isDir: false })).resolves.toBe(false);
		} finally {
			window.removeEventListener("musepi-gui-toast", onToast);
		}
		expect(notices).toEqual([t("settings.addToChatFailed", { name: "a.md" })]);
		expect(composer.inserted).toEqual([]);
	});
});
