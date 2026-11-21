; installer-preview.nsi — 安装流程的可运行预览与回归 harness
;
; 用途：在不需要 electron-builder 完整打包（也不需要先构建 daemon 二进制）
; 的前提下，产出一个能双击走完**真实时序**的 setup.exe：
;
;   宿主提问 → answers.ini → 安装器切静默 → 后台写入文件 → phase=done
;   → 宿主显示完成页 → 宿主退出 → 安装器以 0 退出
;
; 它包含**生产用**的 release/installer-branding.nsh 与 ensure-shortcuts.nsh，
; 所以「普通安装是否会露出原生 NSIS 页面」这类回归在这里就能被抓到
; （scripts/capture-installer-pages.ps1 会断言预览进程在整个流程中没有任何
; 可见窗口）。
;
; 与真实安装器的差异（刻意保留，避免误当成正式包）：
;   * section 只写若干占位文件并 Sleep，模拟一个持续数秒的文件释放阶段
;   * MUSE_INSTALLER_PREVIEW 关掉真实桌面/开始菜单快捷方式写入
;   * 不写卸载注册项、不生成卸载器
;
; 编译：python apps/desktop/scripts/build-installer-preview.py
; 手动：
;   makensis /INPUTCHARSET UTF8 \
;     /DPROJECT_DIR=<abs apps/desktop> \
;     /DBUILD_RESOURCES_DIR=<abs apps/desktop/build> \
;     /DOUTDIR=<abs out dir> \
;     installer/preview/installer-preview.nsi

Unicode true
Name "MusePi 安装程序预览"
RequestExecutionLevel user

!ifndef PROJECT_DIR
  !error "PROJECT_DIR must be passed via /D"
!endif
!ifndef BUILD_RESOURCES_DIR
  !error "BUILD_RESOURCES_DIR must be passed via /D"
!endif
!ifndef OUTDIR
  !error "OUTDIR must be passed via /D (absolute output directory)"
!endif

OutFile "${OUTDIR}\MusePi-installer-preview.exe"

!define PRODUCT_NAME "MusePi"
!define PRODUCT_FILENAME "MusePi"
!define VERSION "0.0.0-preview"
!define APP_FILENAME "MusePi"
!ifndef SHORTCUT_NAME
  !define SHORTCUT_NAME "MusePi"
!endif

; 预览不写真实快捷方式（见 ensure-shortcuts.nsh 的 customInstall）。
!define MUSE_INSTALLER_PREVIEW

!include "MUI2.nsh"
!include "LogicLib.nsh"

; 生产用的宿主启动、答案解析、静默切换与卸载定义。
!include "${PROJECT_DIR}\release\installer-branding.nsh"

; ── 页面声明与真实模板一致；宿主接管后整体静默，一个都不会创建 ──────────
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION "PreviewStartApp"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "English"

; customHeader 必须在 MUI_LANGUAGE 之后——LangString 此时才能注册。
!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Function PreviewStartApp
FunctionEnd

Var PreviewTestUninstallKey
Var PreviewFailBeforeDone

Function .onInit
  ; 截图脚本用这个环境变量把安装目标放到仓库的临时目录里。
  ReadEnvStr $0 "MUSEPI_PREVIEW_INSTALL_ROOT"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${Else}
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\MusePiPreview"
  ${EndIf}

  ; 回滚证据用的一次性卸载键名（由截图脚本生成，随机后缀）。设置后本预览会
  ; 在目标的 HKCU Uninstall 下写一条指向 $INSTDIR 的条目，取消/失败回滚必须
  ; 把它删掉；成功路径不设置，因此不会留下任何注册表残留。
  ReadEnvStr $PreviewTestUninstallKey "MUSEPI_PREVIEW_TEST_UNINSTALL_KEY"

  ; 模拟"在 customInstall 之前失败"：写完部分文件后直接以 3 退出，安装器不进
  ; 入完成握手，宿主必须按失败回滚。
  ReadEnvStr $PreviewFailBeforeDone "MUSEPI_PREVIEW_FAIL_BEFORE_DONE"

  !ifmacrodef customInit
    !insertmacro customInit
  !endif
FunctionEnd

Section "install"
  SetOutPath "$INSTDIR"

  ; 生产模板在解压前写注册表（registryAddInstallInfo 在 installApplicationFiles
  ; 之后；这里提前写，是为了让"解压中途取消/失败"也能测到卸载条目回滚）。
  ${If} $PreviewTestUninstallKey != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$PreviewTestUninstallKey" \
      "UninstallString" '"$INSTDIR\Uninstall MusePi.exe" --currentuser'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$PreviewTestUninstallKey" \
      "QuietUninstallString" '"$INSTDIR\Uninstall MusePi.exe" --currentuser /S'
  ${EndIf}

  ; 约 5.6 秒的"文件释放"阶段：宿主的阶段文案与字节数必须在这段时间里
  ; 如实变化，截图脚本也在这里取进度页证据。
  StrCpy $2 0
  ${Do}
    IntOp $2 $2 + 1
    FileOpen $0 "$INSTDIR\preview-part-$2.txt" w
    StrCpy $3 0
    ${Do}
      IntOp $3 $3 + 1
      FileWrite $0 "MusePi installer preview — no application files are installed.$\r$\n"
      ${If} $3 >= 1500
        ${ExitDo}
      ${EndIf}
    ${Loop}
    FileClose $0
    Sleep 700
    ; 失败模式：写到一半直接以 3 退出，永不进入 customInstall 的完成握手。
    ${If} $PreviewFailBeforeDone != ""
    ${AndIf} $2 >= 3
      SetErrorLevel 3
      Quit
    ${EndIf}
    ${If} $2 >= 8
      ${ExitDo}
    ${EndIf}
  ${Loop}

  FileOpen $0 "$INSTDIR\PREVIEW-ONLY.txt" w
  FileWrite $0 "This is a MusePi installer UI preview.$\r$\n"
  FileWrite $0 "No application files were installed.$\r$\n"
  FileClose $0

  ; 与 installSection.nsh 相同的调用点：此时文件已落盘，接着写 phase=done
  ; 并等宿主关闭完成页。
  !ifmacrodef customInstall
    !insertmacro customInstall
  !endif
SectionEnd