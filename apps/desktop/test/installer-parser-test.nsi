; installer-parser-test.nsi — 单元测试 answers.ini 的行解析
;
; MuseApplyHostAnswers 是手写的 key=value 拆分（NSIS 没有 JSON 解析器，
; 也没有可用的 StrLoc），是本集成里最容易出错的一段。这里给它喂一组
; 边界用例，把解析结果写进文件供脚本断言：
;   * 普通路径
;   * 路径中含 '='（必须以第一个 '=' 切分）
;   * 值中含空格
;   * 空行 / CRLF
;
; 编译运行方式见 scripts/test-installer-answers-parser.ps1

Unicode true
Name "answers.ini parser test"
OutFile "..\release\answers-parser-test.exe"
InstallDir "$TEMP\MusePiParserTest"
RequestExecutionLevel user
SilentInstall silent

!ifndef PROJECT_DIR
  !error "PROJECT_DIR must be passed via /D"
!endif
!ifndef BUILD_RESOURCES_DIR
  !error "BUILD_RESOURCES_DIR must be passed via /D"
!endif

!define PRODUCT_NAME "MusePi"
!define PRODUCT_FILENAME "MusePi"
!define VERSION "0.0.0"
!define APP_FILENAME "MusePi"

!include "MUI2.nsh"
!include "LogicLib.nsh"

; 生产脚本（含 MuseApplyHostAnswers）
!include "${PROJECT_DIR}\release\installer-branding.nsh"

Section
  ; 让生产函数读测试夹具（函数会尊重预先设置好的 $MuseAnswersFile）
  StrCpy $MuseAnswersFile "$TEMP\musepi-parser-fixture.ini"

  StrCpy $MuseInstallPath ""
  StrCpy $MuseLanguage ""
  StrCpy $MuseDesktopShortcut ""
  StrCpy $MuseStartMenu ""

  Call MuseApplyHostAnswers

  SetOutPath "$TEMP"
  FileOpen $0 "$TEMP\musepi-parser-result.txt" w
  FileWrite $0 "path=[$MuseInstallPath]$\r$\n"
  FileWrite $0 "language=[$MuseLanguage]$\r$\n"
  FileWrite $0 "desktopShortcut=[$MuseDesktopShortcut]$\r$\n"
  FileWrite $0 "startMenu=[$MuseStartMenu]$\r$\n"
  FileClose $0
SectionEnd
