import io

p = "packages/desktop-app/src/components/ContextPanel.tsx"
s = io.open(p, encoding="utf-8").read()
T = "\t"

# 1) drop the backdrop ref (the scrim goes away entirely)
old = (T + "const backdropRef = useRef<HTMLDivElement | null>(null);\n")
assert s.count(old) == 1, ("ref", s.count(old))
s = s.replace(old, "", 1)

old2 = (T + "\t\tconst targets = [panel, backdropRef.current].filter((el): el is HTMLElement => el !== null);\n")
assert s.count(old2) == 1, ("targets", s.count(old2))
s = s.replace(old2, T + "\t\tconst targets = [panel].filter((el): el is HTMLElement => el !== null);\n", 1)

# 2) remove the scrim render
old3 = (T * 3 + "{/* Maximize modal scrim (user: 最大化没有遮罩、前后内容重叠): dims the\n")
i = s.index(old3)
j = s.index(T * 3 + "/>\n", i) + len(T * 3 + "/>\n")
s = s[:i] + (T * 3 + "{/* Maximize: NO scrim (user 2026-09-16 — 正常缩放卡片尺寸即可). The\n"
             + T * 3 + " * panel floats exactly over the measured chat-column card; the\n"
             + T * 3 + " * surrounding gutters stay live and clicking the chat keeps working. */}\n") + s[j:]

io.open(p, "w", encoding="utf-8").write(s)
print("scrim removed")
