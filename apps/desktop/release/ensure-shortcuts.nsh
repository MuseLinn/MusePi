; ensure-shortcuts.nsh — MusePi 桌面快捷方式无条件重建
;
; electron-builder 默认 NSIS 模板的 KeepShortcuts 保留机制在 OTA 更新时
; 假设快捷方式仍存在，只在 oldLink != newLink 时重命名迁移；若快捷方式
; 已被用户/清理工具删除，更新后不会补建（症状：更新后桌面无图标）。
; open-design 的做法是自定义 NSIS 每次安装/更新无条件 CreateShortCut。
;
; 本 include 定义 customInstall 宏——installSection.nsh 在安装文件提取、
; 注册表与快捷方式全部写完后调用它——每次安装（含 silent 更新）都重建桌面
; + 开始菜单快捷方式。
;
; 宿主驱动的安装在这里收尾：先告诉宿主 phase=done，再等宿主关闭完成页。
; 安装器不提前退出，是为了让宿主的"安装完成"有事实依据——它看到的是安装器
; 自己写的标记，而不是"文件看着差不多了"。OTA（`--updated /S`）没有宿主，
; $MuseDriven 为 0，两行都不执行。

!macro customInstall
  ; 预览 harness 用 MUSE_INSTALLER_PREVIEW 关掉真实桌面/开始菜单写入：
  ; 它跑的是同一份 customInstall，不能在开发者机器上留下指向预览目录的图标。
  !ifndef MUSE_INSTALLER_PREVIEW
    ; 重建桌面快捷方式（electron-builder 默认 addDesktopLink 受 keepShortcuts 门控，这里绕过）
    CreateShortCut "$DESKTOP\MusePi.lnk" "$INSTDIR\MusePi.exe" "" "$INSTDIR\MusePi.exe" 0 "" "" "MusePi"
    ; 重建开始菜单快捷方式（放在开始菜单根，与 electron-builder 默认一致）
    CreateShortCut "$SMPROGRAMS\MusePi.lnk" "$INSTDIR\MusePi.exe" "" "$INSTDIR\MusePi.exe" 0 "" "" "MusePi"
    ; 通知 shell 快捷方式变更，避免资源管理器缓存旧状态
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  !endif

  ; 安装器此刻已经没有别的事做，留着进程只是为了让宿主能确认"文件确实全部
  ; 写完"。宿主被强杀时靠计数兜底（250ms × 7200 = 30 分钟）。
  ${If} $MuseDriven == "1"
    StrCpy $MusePhase "done"
    Call MusePublishPhase
    StrCpy $R9 0
    ${Do}
      Sleep 250
      IntOp $R9 $R9 + 1
      ${If} $R9 > 7200
        ${ExitDo}
      ${EndIf}
      Call MuseHostAlive
      ${If} $MuseProbeAlive == "0"
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}
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
