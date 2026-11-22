/**
 * The read-only `~/.ssh/config` reader.
 *
 * What matters here is not parsing (that lives in the renderer's pure parser)
 * but the two promises the reader makes to a user's own file: it never writes,
 * and nothing about it is fatal. A missing file is an empty catalog, an include
 * cycle stops instead of recursing, and an unreadable include costs only its
 * own hosts.
 */
const { describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { includeDirectives, readSshConfig } = require("../electron/ssh-config-read.cjs");

const dirs = [];

/** A throwaway home directory with an `~/.ssh` tree. */
function home(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-ssh-"));
	dirs.push(root);
	const sshDir = path.join(root, ".ssh");
	fs.mkdirSync(sshDir, { recursive: true });
	for (const [name, text] of Object.entries(files)) {
		const file = path.join(sshDir, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
	return root;
}

const cleanup = () => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};

describe("~/.ssh/config reader", () => {
	it("reads the main file", () => {
		const root = home({ config: "Host build\n  HostName build.example.com\n" });
		const documents = readSshConfig({ home: root });
		cleanup();
		expect(documents).toHaveLength(1);
		expect(documents[0].path).toBe(path.join(root, ".ssh", "config"));
		expect(documents[0].text).toContain("build.example.com");
	});

	it("a missing file is an empty catalog, not an error", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-ssh-"));
		dirs.push(root);
		expect(readSshConfig({ home: root })).toEqual([]);
		cleanup();
	});

	it("an Include lands where the directive appeared", () => {
		// ssh(1) reads the included text in place, so a host defined after the
		// Include must not come before it.
		const root = home({
			config: "Host first\n  HostName first.example.com\nInclude extra\nHost last\n  HostName last.example.com\n",
			extra: "Host middle\n  HostName middle.example.com\n",
		});
		const documents = readSshConfig({ home: root });
		cleanup();
		expect(documents.map(document => path.basename(document.path))).toEqual(["config", "extra"]);
		expect(documents[0].text.indexOf("first.example.com")).toBeLessThan(documents[0].text.indexOf("Include extra"));
	});

	it("a glob Include expands to the matching files in a stable order", () => {
		const root = home({
			config: "Include config.d/*.conf\n",
			"config.d/b.conf": "Host b\n",
			"config.d/a.conf": "Host a\n",
			"config.d/notes.txt": "not ssh\n",
		});
		const documents = readSshConfig({ home: root });
		cleanup();
		// The pattern filters (a bare `*` would match notes.txt too, exactly as
		// ssh(1) does) and the expansion is sorted, so two runs agree.
		expect(documents.map(document => path.basename(document.path))).toEqual(["config", "a.conf", "b.conf"]);
	});

	it("a self-including file stops instead of recursing forever", () => {
		const root = home({ config: "Include config\nHost loop\n" });
		const documents = readSshConfig({ home: root });
		cleanup();
		expect(documents).toHaveLength(1);
	});

	it("two files including each other stop too", () => {
		const root = home({ config: "Include a\n", a: "Include config\nHost a\n" });
		const documents = readSshConfig({ home: root });
		cleanup();
		expect(documents.map(document => path.basename(document.path)).sort()).toEqual(["a", "config"]);
	});

	it("an Include depth limit holds for a long chain", () => {
		const files = { config: "Include level1\n" };
		for (let level = 1; level <= 12; level++) files[`level${level}`] = `Include level${level + 1}\n`;
		const root = home(files);
		const documents = readSshConfig({ home: root });
		cleanup();
		// Bounded rather than unbounded: the chain cannot walk forever.
		expect(documents.length).toBeLessThanOrEqual(7);
	});

	it("an unreadable include costs only its own hosts", () => {
		const root = home({ config: "Include does-not-exist\nHost kept\n  HostName kept.example.com\n" });
		const documents = readSshConfig({ home: root });
		cleanup();
		expect(documents).toHaveLength(1);
		expect(documents[0].text).toContain("kept.example.com");
	});

	it("a directory named config is not read as a file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-ssh-"));
		dirs.push(root);
		fs.mkdirSync(path.join(root, ".ssh", "config"), { recursive: true });
		expect(readSshConfig({ home: root })).toEqual([]);
		cleanup();
	});

	it("finds Include only as a directive", () => {
		expect(includeDirectives("# Include nope\nInclude real\n  include=two words\n")).toEqual([
			"real",
			"two",
			"words",
		]);
		expect(includeDirectives("IncludeD something\n")).toEqual([]);
	});
});
