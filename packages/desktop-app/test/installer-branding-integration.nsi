; installer-branding-integration.nsi — 集成链路的可运行验证
;
; 目的：验证"NSIS 启动 WebView2 宿主 → 宿主问完 → 写 answers.ini →
; NSIS 读回答案 → 继续安装"这条链路，而不需要先构建完整的 daemon 二进制
; （那要几十分钟，且与集成正确性无关）。
;
; 与真实构建的差异，全部是**刻意**的：
;   * 不打包 Electron 应用，只写一个标记文件代表"安装完成"
;   * 进程名 / 目录名带 Preview 后缀，避免与真实安装冲突
;   * 不写注册表，不建快捷方式
;
; 页面顺序、宿主调用方式、answers.ini 协议、静默跳过逻辑都复用生产用的
; release/installer-branding.nsh，所以这里跑通 = 集成链路正确。

Unicode true
Name "MusePi 安装器集成验证"
OutFile "..\release\MusePi-installer-integration-test.exe"
InstallDir "$LOCALAPPDATA\Programs\MusePiIntegrationTest"
RequestExecutionLevel user
ShowInstDetails show

!ifndef PROJECT_DIR
  !error "PROJECT_DIR must be passed via /D"
!endif
!ifndef BUILD_RESOURCES_DIR
  !error "BUILD_RESOURCES_DIR must be passed via /D"
!endif

!define PRODUCT_NAME "MusePi"
!define PRODUCT_FILENAME "MusePi"
!define VERSION "0.5.6"
!define APP_FILENAME "MusePi"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; 生产用的集成脚本：变量、宿主调用、answers.ini 解析、静默判断全在这里
!include "${PROJECT_DIR}\release\installer-branding.nsh"

; ── 位图（真实构建里由 electron-builder 注入）──────────────────────────
!define MUI_WELCOMEFINISHPAGE_BITMAP   "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${BUILD_RESOURCES_DIR}\uninstallerSidebar.bmp"

; ── 页面：欢迎页（宿主）→ 目录 → 安装 → 完成 ──────────────────────────
!ifmacrodef customWelcomePage
  !insertmacro customWelcomePage
!endif
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Section "install"
  ; 证明"NSIS 读到了宿主给出的答案"：把解析结果写进安装目录，
  ; 供自动化脚本断言。
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\integration-result.txt" w
  FileWrite $0 "installPath=$INSTDIR$\r$\n"
  FileWrite $0 "language=$MuseLanguage$\r$\n"
  FileWrite $0 "desktopShortcut=$MuseDesktopShortcut$\r$\n"
  FileWrite $0 "startMenu=$MuseStartMenu$\r$\n"
  FileWrite $0 "hostExit=$MuseHostExit$\r$\n"
  FileClose $0
SectionEnd
