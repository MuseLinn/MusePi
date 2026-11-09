import { describe, expect, test } from "bun:test";
import { isRemoteMirrorCwd } from "../src/lib/workspace-roots";

describe("isRemoteMirrorCwd", () => {
	test("matches POSIX and Windows remote mounts", () => {
		expect(isRemoteMirrorCwd("/home/me/.musepi/remote/host-a/project")).toBe(true);
		expect(isRemoteMirrorCwd("C:\\Users\\me\\.musepi\\remote\\host-a\\project")).toBe(true);
	});

	test("does not match ordinary projects", () => {
		expect(isRemoteMirrorCwd("/work/project")).toBe(false);
		expect(isRemoteMirrorCwd("D:\\Projects\\Agents\\MusePi")).toBe(false);
		expect(isRemoteMirrorCwd(undefined)).toBe(false);
	});
});
