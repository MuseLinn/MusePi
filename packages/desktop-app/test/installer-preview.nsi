; installer-preview.nsi — 品牌化安装向导的**可运行预览**
;
; 用途：在不需要 electron-builder 完整打包（也不需要先构建 daemon 二进制）
; 的前提下，产出一个能双击走完所有页面的 setup.exe，用来验收视觉与文案。
;
; 与真实安装器的差异（刻意保留，避免误当成正式包）：
;   * section 里只放一张说明文件，不解压 Electron 应用
;   * 不写注册表、不建快捷方式、不生成卸载器
;   * 页面顺序、位图、配色、LangString 全部走**生产用**的
;     release/installer-branding.nsh，所以看到的就是正式安装器的观感
;
; 编译（从 packages/desktop-app 目录）：
;   powershell -File scripts/build-installer-preview.ps1
; 或手动：
;   makensis /INPUTCHARSET UTF8 \
;     /DPROJECT_DIR=<abs packages/desktop-app> \
;     /DBUILD_RESOURCES_DIR=<abs packages/desktop-app/build> \
;     test/installer-preview.nsi

Unicode true
Name "MusePi 安装程序预览"
OutFile "..\release\MusePi-installer-preview.exe"
InstallDir "$LOCALAPPDATA\Programs\MusePiPreview"
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

; 生产用的自绘宿主启动、答案解析与卸载定义
!include "${PROJECT_DIR}\release\installer-branding.nsh"

; ── 位图 ─────────────────────────────────────────────────────────────────
; 真实构建里这三个 define 由 electron-builder 的 defines 对象注入
; （NsisTarget.js 按 options.installerSidebar / installerHeader 解析后传 /D）。
; 独立编译必须自己给，否则 MUI 回退到 NSIS 默认的蓝色 nsis3-metro.bmp。
!define MUI_WELCOMEFINISHPAGE_BITMAP     "${BUILD_RESOURCES_DIR}\installerSidebar.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP   "${BUILD_RESOURCES_DIR}\uninstallerSidebar.bmp"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP           "${BUILD_RESOURCES_DIR}\installerHeader.bmp"

; ── 原生页面声明与真实模板一致；customInit 后静默跳过 ─────────────────
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

; 完成页的「立即启动」勾选框：真实模板由 assistedInstaller.nsh 定义
; MUI_FINISHPAGE_RUN + StartApp 函数（并把 --updated 透传给应用）。
; 预览没有 StartApp，用一个空函数占位即可得到同样的视觉。
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION "PreviewStartApp"
!insertmacro MUI_PAGE_FINISH

Function PreviewStartApp
FunctionEnd

; ── 语言（模板里由 addLangs 宏插入，这里等价展开）────────────────────────
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; customHeader 必须在 MUI_LANGUAGE 之后——LangString 此时才能注册
!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Function .onInit
  !ifmacrodef customInit
    !insertmacro customInit
  !endif
FunctionEnd

Section "install"
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\PREVIEW-ONLY.txt" w
  FileWrite $0 "This is a MusePi installer UI preview.$\r$\n"
  FileWrite $0 "No application files were installed.$\r$\n"
  FileClose $0
SectionEnd
