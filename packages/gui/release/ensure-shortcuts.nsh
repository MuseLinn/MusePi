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
