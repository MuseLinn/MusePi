// @musepi/core — /move 纯解析规则测试。
import assert from "node:assert";
import * as path from "node:path";
import { describe, it } from "node:test";
import { expandMoveHome, resolveMoveTarget, sameMovePath, unquoteMoveInput } from "../src/move.ts";

describe("unquoteMoveInput", () => {
	it("strips one pair of matching double quotes", () => {
		assert.equal(unquoteMoveInput('"C:\\some dir\\proj"'), "C:\\some dir\\proj");
	});
	it("strips one pair of matching single quotes", () => {
		assert.equal(unquoteMoveInput("'rel dir'"), "rel dir");
	});
	it("leaves mismatched or unquoted input alone", () => {
		assert.equal(unquoteMoveInput('"mixed\''), '"mixed\'');
		assert.equal(unquoteMoveInput("plain"), "plain");
		assert.equal(unquoteMoveInput('"only-open'), '"only-open');
	});
	it("trims surrounding whitespace first", () => {
		assert.equal(unquoteMoveInput('  "x y"  '), "x y");
	});
});

describe("expandMoveHome", () => {
	const home = path.join(path.sep, "home", "user");
	it("expands bare ~", () => {
		assert.equal(expandMoveHome("~", home), home);
	});
	it("expands ~/ suffix", () => {
		assert.equal(expandMoveHome("~/proj", home), path.join(home, "proj"));
	});
	it("leaves other paths untouched", () => {
		assert.equal(expandMoveHome("~other/x", home), "~other/x");
		assert.equal(expandMoveHome("/abs/path", home), "/abs/path");
	});
});

describe("resolveMoveTarget", () => {
	const cwd = path.resolve(path.sep, "work", "proj");
	it("resolves relative input against cwd", () => {
		assert.equal(resolveMoveTarget("sub", cwd), path.resolve(cwd, "sub"));
		assert.equal(resolveMoveTarget("../sibling", cwd), path.resolve(cwd, "../sibling"));
	});
	it("keeps absolute input", () => {
		const abs = path.resolve(path.sep, "elsewhere", "dir");
		assert.equal(resolveMoveTarget(abs, cwd), abs);
	});
	it("unquotes and expands ~ before resolving", () => {
		const home = path.resolve(path.sep, "home", "user");
		assert.equal(resolveMoveTarget('"~/x y"', cwd, home), path.resolve(home, "x y"));
	});
});

describe("sameMovePath", () => {
	it("matches after resolution", () => {
		const a = path.resolve(path.sep, "a", "b");
		const b = path.resolve(path.sep, "a", "c", "..", "b");
		assert.equal(sameMovePath(a, b), true);
	});
	it("rejects different paths", () => {
		assert.equal(sameMovePath(path.resolve(path.sep, "a"), path.resolve(path.sep, "b")), false);
	});
	it("is case-insensitive on win32 only", () => {
		const a = path.resolve(path.sep, "Some", "Dir");
		const b = path.resolve(path.sep, "some", "dir");
		assert.equal(sameMovePath(a, b), process.platform === "win32");
	});
});
