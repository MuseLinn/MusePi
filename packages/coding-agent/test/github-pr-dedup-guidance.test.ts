import { describe, expect, test } from "bun:test";
import githubDescription from "../src/prompts/tools/github.md" with { type: "text" };

describe("github tool guidance", () => {
	test("checks the tracker before fixing or opening a pull request upstream", () => {
		expect(githubDescription).toContain("repo you don't own");
		expect(githubDescription).toMatch(/search_issues`\/`search_prs/);
		expect(githubDescription).toContain("not duplicated");
	});
});
