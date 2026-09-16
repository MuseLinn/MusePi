import io

# 1) surface-tabs.tsx: onTabContextMenu prop
p = "packages/desktop-app/src/components/surface-tabs.tsx"
s = io.open(p, encoding="utf-8").read()
T = "\t"

old = (T + "onClose,\n" + T + "onReorder,\n" + T + 'closeLabel = "close",\n' + T + "ariaLabel,\n")
assert s.count(old) == 1, ("strip props", s.count(old))
s = s.replace(old, old + T + "onTabContextMenu,\n", 1)

# strip props interface: find the SurfaceTabStripProps block and add the field
old = (T + "onReorder(fromId: string, toId: string): void;\n" + T + 'closeLabel?: string;\n')
assert s.count(old) == 1, ("iface", s.count(old))
s = s.replace(old, old + (T + "/** Right-click on a tab (viewport coords). The host owns the menu —\n"
                           + T + " *  the strip stays a pure tab widget. */\n"
                           + T + "onTabContextMenu?(id: string, x: number, y: number): void;\n"), 1)

# pass it down
old = (T * 4 + "\t\t\t\t\t\tcloseLabel={closeLabel}\n"
       + T * 4 + "\t\t\t\t\t\tonActivate={onActivate}\n"
       + T * 4 + "\t\t\t\t\t\tonClose={onClose}\n")
if s.count(old) == 0:
    old = (T * 5 + "closeLabel={closeLabel}\n" + T * 5 + "onActivate={onActivate}\n" + T * 5 + "onClose={onClose}\n")
assert s.count(old) == 1, ("pass-down", s.count(old))
s = s.replace(old, old.replace("onClose={onClose}", "onClose={onClose}\n" + T * 5 + "onTabContextMenu={onTabContextMenu}"), 1)

# SurfaceTabButton: prop + handler
old = (T + "onActivate,\n" + T + "onClose,\n" + "}: {\n" + T + "tab: SurfaceTab;\n" + T + "active: boolean;\n" + T + "closeLabel: string;\n" + T + "onActivate(id: string): void;\n" + T + "onClose(id: string): void;\n")
assert s.count(old) == 1, ("button props", s.count(old))
s = s.replace(old, old.replace("onClose(id: string): void;", "onClose(id: string): void;\n" + T + "onTabContextMenu?(id: string, x: number, y: number): void;") .replace(T + "onActivate,\n", T + "onActivate,\n" + T + "onClose,\n" + T + "onTabContextMenu,\n", 1), 1)
# note: the replace above re-orders onClose; fix by ensuring both onClose and onTabContextMenu exist once in destructure
# wire the event on the button
old2 = (T * 3 + "\t\t\tonAuxClick={e => {\n")
assert s.count(old2) == 1, ("auxclick", s.count(old2))
s = s.replace(old2,
    T * 3 + "\t\t\tonContextMenu={e => {\n"
    + T * 3 + "\t\t\t\tif (!onTabContextMenu) return;\n"
    + T * 3 + "\t\t\t\te.preventDefault();\n"
    + T * 3 + "\t\t\t\tonTabContextMenu(tab.id, e.clientX, e.clientY);\n"
    + T * 3 + "\t\t\t}}\n"
    + old2, 1)

io.open(p, "w", encoding="utf-8").write(s)
print("surface-tabs context menu wired")
