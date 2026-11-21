import "../../../test/happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { t } from "../../i18n/index.js";
import {
	type AddToChatDraftApi,
	type AddToChatFile,
	type AddToChatKey,
	addFileToChat,
	addToChatUnavailableReason,
	noteAddToChatFocus,
	registerAddToChatDraft,
	registerAddToChatFiles,
} from "./add-to-chat";

/** The bridge is the only thing the file menu calls; these fakes stand in for
 *  the composer (draft insertion) and the attachment intake (chip staging).
 *  Every fake owns a key, like a real composer entry does. */
function fakeComposer(options: { editable?: boolean } = {}): {
	key: AddToChatKey;
	draft: AddToChatDraftApi;
	files: { addWorkspaceFile(file: AddToChatFile): Promise<string | null> };
	inserted: string[];
	staged: AddToChatFile[];
	editable: { value: boolean };
	focused: { value: boolean };
} {
	const editable = { value: options.editable ?? true };
	const focused = { value: false };
	const inserted: string[] = [];
	const staged: AddToChatFile[] = [];
	return {
		key: {},
		editable,
		focused,
		inserted,
		staged,
		draft: {
			canInsert: () => editable.value,
			insertMention: label => inserted.push(label),
			containsFocus: () => focused.value,
		},
		files: {
			addWorkspaceFile: async file => {
				staged.push(file);
				return "文件1";
			},
		},
	};
}

let disposers: (() => void)[] = [];
afterEach(() => {
	for (const dispose of disposers.reverse()) dispose();
	disposers = [];
});

function connect(composer: ReturnType<typeof fakeComposer>): () => void {
	const dispose = () => {
		disposeDraft();
		disposeFiles();
	};
	const disposeDraft = registerAddToChatDraft(composer.key, composer.draft);
	const disposeFiles = registerAddToChatFiles(composer.key, composer.files);
	disposers.push(dispose);
	return dispose;
}

function connectDraftOnly(composer: ReturnType<typeof fakeComposer>): void {
	disposers.push(registerAddToChatDraft(composer.key, composer.draft));
}

function connectFilesOnly(composer: ReturnType<typeof fakeComposer>): void {
	disposers.push(registerAddToChatFiles(composer.key, composer.files));
}

async function addFile(): Promise<boolean> {
	return addFileToChat({ path: "/work/a.md", name: "a.md", size: 3, isDir: false });
}

describe("Add to chat availability", () => {
	test("no composer registered: the menu item is disabled with a reason", () => {
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
	});

	test("a file intake without a session draft is not enough", () => {
		connectFilesOnly(fakeComposer());
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
	});

	test("a disabled editor reports the reason instead of accepting the click", () => {
		connect(fakeComposer({ editable: false }));
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
	});

	test("both halves registered and editable: the item is live", () => {
		connect(fakeComposer());
		expect(addToChatUnavailableReason()).toBeNull();
	});
});

describe("several live composers", () => {
	test("a fresh second composer does not steal the draft nobody typed in", () => {
		const main = fakeComposer();
		const side = fakeComposer();
		connect(main);
		connect(side);
		expect(addToChatUnavailableReason()).toBeNull();
		return addFile().then(added => {
			expect(added).toBe(true);
			expect(main.inserted).toEqual(["文件1"]);
			expect(side.inserted).toEqual([]);
		});
	});

	test("the composer holding focus takes the insertion", async () => {
		const main = fakeComposer();
		const side = fakeComposer();
		connect(main);
		connect(side);
		side.focused.value = true;
		await expect(addFile()).resolves.toBe(true);
		expect(side.inserted).toEqual(["文件1"]);
		expect(main.inserted).toEqual([]);
	});

	test("recent interaction decides when focus is elsewhere (the file tree)", async () => {
		const main = fakeComposer();
		const side = fakeComposer();
		connect(main);
		connect(side);
		// Right-clicking the tree may move focus off both editors.
		side.focused.value = false;
		noteAddToChatFocus(side.key);
		await expect(addFile()).resolves.toBe(true);
		expect(side.inserted).toEqual(["文件1"]);
		noteAddToChatFocus(main.key);
		await expect(addFile()).resolves.toBe(true);
		expect(main.inserted).toEqual(["文件1"]);
	});

	test("closing one composer leaves the other live instead of reporting unavailable", async () => {
		const main = fakeComposer();
		const side = fakeComposer();
		connect(main);
		const closeSide = connect(side);
		side.focused.value = true;
		expect(addToChatUnavailableReason()).toBeNull();
		// The side session tab closes; its registrations withdraw.
		closeSide();
		expect(addToChatUnavailableReason()).toBeNull();
		await expect(addFile()).resolves.toBe(true);
		expect(main.inserted).toEqual(["文件1"]);
	});
});

describe("halves stay paired with their own composer", () => {
	test("a draft from one composer never borrows another's intake", async () => {
		const first = fakeComposer();
		const second = fakeComposer();
		connectDraftOnly(first);
		connectFilesOnly(second);
		// Both halves exist, but under different keys: nothing may pair them.
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));
		await expect(addFile()).resolves.toBe(false);
		expect(first.inserted).toEqual([]);
		expect(second.staged).toEqual([]);

		// Completing the FIRST composer pairs its own halves, not the other's.
		connectFilesOnly(first);
		await expect(addFile()).resolves.toBe(true);
		expect(first.staged).toEqual([{ path: "/work/a.md", name: "a.md", size: 3 }]);
		expect(first.inserted).toEqual(["文件1"]);
		expect(second.inserted).toEqual([]);
	});

	test("a welcome draft without an intake never pairs with a session's files", async () => {
		const hero = fakeComposer();
		const session = fakeComposer();
		connectDraftOnly(hero);
		connectFilesOnly(session);
		expect(addToChatUnavailableReason()).toBe(t("settings.addToChatUnavailable"));

		connectDraftOnly(session);
		expect(addToChatUnavailableReason()).toBeNull();
		await expect(addFile()).resolves.toBe(true);
		expect(session.inserted).toEqual(["文件1"]);
		expect(hero.inserted).toEqual([]);
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
