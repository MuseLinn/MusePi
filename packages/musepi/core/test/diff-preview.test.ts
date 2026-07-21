// MusePi core — clustered diff preview tests.
// Ported from kimi-code apps/kimi-code/test/tui/components/media/diff-preview.test.ts,
// adapted to node:test and the dependency-free (plain styles) core API.
import assert from "node:assert";
import { describe, it } from "node:test";
import {
  computeDiffLines,
  renderDiffLines,
  renderDiffLinesClustered,
} from "../src/tui/diff-preview.ts";

describe("computeDiffLines", () => {
  it("renders a complete diff when isIncomplete is false", () => {
    const lines = computeDiffLines("A\nB\nC\nD", "A\nB", 1, 1, false);
    assert.deepStrictEqual(
      lines.map((l) => l.kind),
      ["context", "context", "delete", "delete"],
    );
  });

  it("suppresses trailing deletes when isIncomplete is true", () => {
    const lines = computeDiffLines("A\nB\nC\nD", "A\nB", 1, 1, true);
    assert.deepStrictEqual(
      lines.map((l) => l.kind),
      ["context", "context"],
    );
  });

  it("suppresses all deletes when everything would be deleted and incomplete", () => {
    const lines = computeDiffLines("A\nB\nC", "", 1, 1, true);
    assert.deepStrictEqual(lines, []);
  });

  it("keeps trailing adds when isIncomplete is true", () => {
    const lines = computeDiffLines("A\nB\nC", "A\nB\nX", 1, 1, true);
    assert.deepStrictEqual(
      lines.map((l) => l.kind),
      ["context", "context", "delete", "add"],
    );
  });

  it("keeps internal delete blocks that are not trailing", () => {
    const lines = computeDiffLines("A\nB\nC\nD", "A\nC", 1, 1, true);
    assert.deepStrictEqual(
      lines.map((l) => l.kind),
      ["context", "delete", "context"],
    );
  });

  it("aligns interleaved changes via LCS rather than naive line position", () => {
    const lines = computeDiffLines("A\nB\nC", "A\nX\nB\nC", 1, 1, false);
    assert.deepStrictEqual(
      lines.map((l) => l.kind),
      ["context", "add", "context", "context"],
    );
    assert.strictEqual(lines[1]!.lineNum, 2);
    assert.strictEqual(lines[1]!.code, "X");
  });
});

describe("renderDiffLines", () => {
  it("does not show removed count for suppressed trailing deletes", () => {
    const text = renderDiffLines("A\nB\nC\nD", "A\nB", "test.ts", true, 1, 1).join("\n");
    assert.ok(text.includes("test.ts"));
    assert.ok(!text.includes("-2"));
    assert.ok(!text.includes("C"));
    assert.ok(!text.includes("D"));
    // When trailing deletes are suppressed, only context lines remain;
    // renderDiffLines only emits changed lines, so the body is empty.
    assert.ok(!text.includes("A"));
    assert.ok(!text.includes("B"));
  });

  it("shows removed count for complete diffs", () => {
    const text = renderDiffLines("A\nB\nC\nD", "A\nB", "test.ts", false, 1, 1).join("\n");
    assert.ok(text.includes("-2"));
    assert.ok(text.includes("C"));
    assert.ok(text.includes("D"));
  });
});

describe("renderDiffLinesClustered", () => {
  it("renders header with file path and counts", () => {
    const out = renderDiffLinesClustered("A\nB\nC", "A\nX\nC", "foo.ts");
    assert.ok(out[0]!.includes("+1"));
    assert.ok(out[0]!.includes("-1"));
    assert.ok(out[0]!.includes("foo.ts"));
  });

  it("returns header only when there are no changes", () => {
    const out = renderDiffLinesClustered("A\nB", "A\nB", "foo.ts");
    assert.strictEqual(out.length, 1);
    assert.ok(out[0]!.includes("foo.ts"));
  });

  it("shows context lines around a single change cluster", () => {
    // Five lines, change line 3 only — context is 1 each side.
    const oldText = ["L1", "L2", "L3", "L4", "L5"].join("\n");
    const newText = ["L1", "L2", "L3X", "L4", "L5"].join("\n");
    const text = renderDiffLinesClustered(oldText, newText, "f.ts", { contextLines: 1 }).join("\n");
    assert.ok(text.includes("L2"));
    assert.ok(text.includes("L3"));
    assert.ok(text.includes("L3X"));
    assert.ok(text.includes("L4"));
    assert.ok(!text.includes("L1"));
    assert.ok(!text.includes("L5"));
  });

  it("elides unchanged middle between two clusters with a separator", () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 30; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[1] = "L2X"; // change near top
    newLines[28] = "L29X"; // change near bottom
    const text = renderDiffLinesClustered(oldLines.join("\n"), newLines.join("\n"), "f.ts", {
      contextLines: 2,
    }).join("\n");
    assert.ok(text.includes("L2X"));
    assert.ok(text.includes("L29X"));
    assert.match(text, /… \d+ unchanged lines? …/);
    // Middle untouched lines (e.g. L15) should not appear.
    assert.ok(!text.includes("L15"));
  });

  it("merges nearby change clusters when the gap is within context window", () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 10; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[2] = "L3X";
    newLines[5] = "L6X"; // gap of 2 lines between change indices 2 and 5 → merges with contextLines=2 (mergeGap=4)
    const text = renderDiffLinesClustered(oldLines.join("\n"), newLines.join("\n"), "f.ts", {
      contextLines: 2,
    }).join("\n");
    assert.doesNotMatch(text, /unchanged lines? …/);
    assert.ok(text.includes("L3X"));
    assert.ok(text.includes("L6X"));
  });

  it("splits clusters when the gap exceeds the merge window", () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 20; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[2] = "L3X";
    newLines[15] = "L16X"; // gap of 12 between change indices 2 and 15 → two clusters at contextLines=2
    const text = renderDiffLinesClustered(oldLines.join("\n"), newLines.join("\n"), "f.ts", {
      contextLines: 2,
    }).join("\n");
    assert.match(text, /… \d+ unchanged lines? …/);
    assert.ok(text.includes("L3X"));
    assert.ok(text.includes("L16X"));
  });

  it("emits a partial body even when a single cluster exceeds maxLines", () => {
    // Worst case from prod: 100 lines fully replaced inline → single huge
    // cluster of ~200 diff entries. With maxLines=10 the renderer must
    // still emit ~10 leading body rows, not just the truncation footer.
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      oldLines.push(`old${String(i)}`);
      newLines.push(`new${String(i)}`);
    }
    const out = renderDiffLinesClustered(oldLines.join("\n"), newLines.join("\n"), "big.ts", {
      contextLines: 3,
      maxLines: 10,
    });
    // header + 10 body rows + truncation footer
    assert.strictEqual(out.length, 12);
    const text = out.join("\n");
    assert.ok(text.includes("+100"));
    assert.ok(text.includes("-100"));
    assert.match(text, /old\d+|new\d+/);
    assert.ok(text.includes("ctrl+o to expand"));
  });

  it("respects oldStart and newStart for line numbers", () => {
    const text = renderDiffLinesClustered("A\nB\nC", "A\nX\nC", "f.ts", {
      contextLines: 1,
      oldStart: 10,
      newStart: 20,
    }).join("\n");
    // Context lines keep the new (post-edit) line numbers from newStart;
    // deleted lines use oldStart; added lines use newStart.
    assert.ok(text.includes("  20   A"));
    assert.ok(text.includes("  11 - B"));
    assert.ok(text.includes("  21 + X"));
    assert.ok(text.includes("  22   C"));
  });

  it("truncates at cluster boundary and appends the ctrl+o footer when maxLines is set", () => {
    const oldLines: string[] = [];
    for (let i = 1; i <= 50; i++) oldLines.push(`L${String(i)}`);
    const newLines = oldLines.slice();
    newLines[1] = "L2X";
    newLines[20] = "L21X";
    newLines[40] = "L41X";
    const text = renderDiffLinesClustered(oldLines.join("\n"), newLines.join("\n"), "f.ts", {
      contextLines: 2,
      maxLines: 6,
    }).join("\n");
    assert.ok(text.includes("L2X"));
    assert.match(text, /more change/);
    assert.ok(text.includes("ctrl+o to expand"));
    assert.ok(!text.includes("L41X"));
  });

  it("applies injected styles to header, gutter, and rows", () => {
    const wrap = (tag: string) => (s: string) => `<${tag}>${s}</${tag}>`;
    const styles = {
      add: wrap("add"),
      del: wrap("del"),
      addBold: wrap("addBold"),
      delBold: wrap("delBold"),
      gutter: wrap("gutter"),
      meta: wrap("meta"),
    };
    const text = renderDiffLinesClustered("A\nB\nC", "A\nX\nC", "f.ts", { styles }).join("\n");
    assert.ok(text.includes("<addBold>+1 </addBold>"));
    assert.ok(text.includes("<delBold>-1 </delBold>"));
    assert.ok(text.includes("<del>- B</del>"));
    assert.ok(text.includes("<add>+ X</add>"));
    assert.ok(text.includes("<gutter>"));
  });
});
