; ensure-shortcuts.nsh — MusePi 桌面快捷方式无条件重建
;
; electron-builder 默认 NSIS 模板的 KeepShortcuts 保留机制在 OTA 更新时
; 假设快捷方式仍存在，只在 oldLink != newLink 时重命名迁移；若快捷方式
; 已被用户/清理工具删除，更新后不会补建（症状：更新后桌面无图标）。
; open-design 的做法是自定义 NSIS 每次安装/更新无条件 CreateShortCut。
; 本 include 定义 customInstall 宏——installSection.nsh 在安装文件提取
; 完成后调用它——每次安装（含 silent 更新）都重建桌面 + 开始菜单快捷方式。

!macro customInstall
  ; 重建桌面快捷方式（electron-builder 默认 addDesktopLink 受 keepShortcuts 门控，这里绕过）
  CreateShortCut "$DESKTOP\MusePi.lnk" "$INSTDIR\MusePi.exe" "" "$INSTDIR\MusePi.exe" 0 "" "" "MusePi"
  ; 重建开始菜单快捷方式（放在开始菜单根，与 electron-builder 默认一致）
  CreateShortCut "$SMPROGRAMS\MusePi.lnk" "$INSTDIR\MusePi.exe" "" "$INSTDIR\MusePi.exe" 0 "" "" "MusePi"
  ; 通知 shell 快捷方式变更，避免资源管理器缓存旧状态
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

; customCheckAppRunning — override electron-builder's default running-app
; check. The default (_CHECK_APP_RUNNING) matches the app executable by
; IMAGE NAME (taskkill /IM MusePi.exe, case-insensitive), which also kills
; every same-named process — including the user's terminal TUI sessions and
; CLI daemon at ~/.musepi/bin/musepi.exe (0.4.19 regression: installing
; while a TUI was live killed it). This override only considers processes
; whose executable path lives under $INSTDIR — the GUI and the vendor daemon
; this install owns — and leaves unrelated musepi.exe processes untouched.
; Escaping follows the stock FIND_PROCESS/KILL_PROCESS macros exactly:
; $$_ is PowerShell's $_ escaped for NSIS, $INSTDIR is single-quoted, and
; the -Command body uses double quotes only at the PS-string level.
!macro customCheckAppRunning
  Push $0
  ; Any process with an executable under $INSTDIR? (exit 0 = found)
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "if ((Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') }).Count -gt 0) { exit 0 } else { exit 1 }"`
  Pop $0
  ${if} $0 == 0
    ; Graceful close first (allow the app to exit without explicit kill)
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -ErrorAction SilentlyContinue }"`
    Sleep 1000
    ; Force-close any that ignored the graceful stop (files in use)
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Sleep 300
  ${endif}
  Pop $0
!macroend
