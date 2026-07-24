// ============================================================
// hashline — 模型侧 patch 格式说明（edit 工具描述用）。
// 与 OMP prompt.md 同思路，按本实现的操作集自行撰写：
// SWAP / DEL / INS.PRE / INS.POST / INS.HEAD / INS.TAIL，无 BLK 变体。
// ============================================================

export const HASHLINE_EDIT_DESCRIPTION = `Edit one or more files with a hashline patch: line-anchored edits verified against a content-hash tag.

FORMAT — one or more file sections; every section starts with a header copied verbatim from read/grep output:
  [path#TAG]
TAG is the 4-hex snapshot tag shown in the [path#TAG] header of your latest read/grep of that file. It is REQUIRED on every section — there is no tagless form. To create a new file, use the write tool instead; hashline only edits files that exist.

Inside a section, hunks address ORIGINAL file lines (the numbers shown as LINE:TEXT in read/grep output):
  SWAP N.=M:   replace original lines N..M with the body rows below (SWAP N: = single line)
  DEL N.=M     delete original lines N..M (DEL N = single line, no body)
  INS.PRE N:   insert the body rows immediately before line N
  INS.POST N:  insert the body rows immediately after line N
  INS.HEAD: / INS.TAIL:   insert at the very start / very end of the file

Body rows appear only under a header ending in ":". Every body row is \`+TEXT\` (literal line, leading whitespace kept; \`+\` alone adds a blank line). There are NO \`-old\` rows and no context rows — the range deletes the old content, the body is only the new content. To insert a literal line starting with \`+\`, write \`++line\`.

RULES
1. RE-GROUND AFTER EVERY EDIT. Each applied edit mints a fresh tag and renumbers the file — the tag and line numbers you just used are dead. Take the next edit's tag and lines from the edit result (or a fresh read), never from pre-edit memory. On a stale-tag rejection, STOP and re-read; never stack more line-numbered edits onto output you have not re-grounded.
2. RANGES ARE TIGHT. Cover only lines whose content actually changes; never widen a range to swallow unchanged lines, and never start or end a range mid-statement. A stale single-line SWAP corrupts one line; a stale wide SWAP shreds the block.
3. ONE HUNK PER RANGE. To change lines 2 and 5 while keeping 3-4, issue two hunks (SWAP 2: and SWAP 5:). Untouched lines are simply absent from every range.
4. Line numbers never shift within one patch — they always refer to the original file, no matter how many hunks precede them.
5. If the file changed on disk since you read it, the tag is rejected (or the edit is recovered only when every touched line moved by one unambiguous offset). The error tells you to re-read — do exactly that.

EXAMPLE — original (as read returns it):
  [greet.py#A1B2]
  1:def greet(name):
  2:    msg = "Hello, " + name
  3:    print(msg)
  4:greet("world")

Replace line 2 with two lines and insert a guard after line 1:
  [greet.py#A1B2]
  INS.POST 1:
  +    if not name:
  +        name = "stranger"
  SWAP 2:
  +    greeting = "Hi"
  +    msg = f"{greeting}, {name}"`;

export const HASHLINE_EDIT_PROMPT_GUIDELINES: readonly string[] = [
	"Use edit with a hashline patch: copy the [path#TAG] header from your latest read/grep, then address original lines with SWAP/DEL/INS hunks",
	"After every successful edit, re-anchor on the fresh tag and line numbers returned in the edit result — pre-edit tags and line numbers are dead",
	"On a stale-tag rejection, re-read the file and retry with the new tag; never guess line numbers from memory",
	"Keep ranges tight: cover only lines that actually change; one hunk per contiguous range",
];
