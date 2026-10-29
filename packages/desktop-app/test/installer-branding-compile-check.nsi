; Minimal harness to compile-check the MusePi installer branding include
; without running a full electron-builder packaging pass.
;
; It mirrors electron-builder's real ordering (installer.nsi):
;
;   !include "assistedInstaller.nsh"    -> MUI_PAGE_* inserted here
;   !insertmacro addLangs               -> MUI_LANGUAGE lines
;   !ifmacrodef customHeader            -> our LangStrings
;   Function .onInit                    -> customInit starts the self-drawn host
;
; MUI requires pages before languages, and LangString only after
; MUI_LANGUAGE — so this order is not cosmetic, it is the contract the
; include relies on.
;
; PROJECT_DIR / BUILD_RESOURCES_DIR come from the caller, exactly like
; electron-builder's generated defines object:
;   makensis /DPROJECT_DIR=<abs> /DBUILD_RESOURCES_DIR=<abs> <this file>
; A missing LangString, a bad bitmap path or an out-of-order macro fails here.

Unicode true
Name "MusePi"
OutFile "NUL"
RequestExecutionLevel user

!ifndef PROJECT_DIR
  !error "PROJECT_DIR must be passed via /D (see header comment)"
!endif
!ifndef BUILD_RESOURCES_DIR
  !error "BUILD_RESOURCES_DIR must be passed via /D (see header comment)"
!endif

!define PRODUCT_NAME "MusePi"
!define PRODUCT_FILENAME "MusePi"
!define VERSION "0.0.0-check"
!define APP_FILENAME "MusePi"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!include "${PROJECT_DIR}\release\installer-branding.nsh"

; ── pages first (mirrors assistedInstaller.nsh) ──────────────────────────
!ifndef BUILD_UNINSTALLER
  !insertmacro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro MUI_PAGE_FINISH
!else
  !ifmacrodef customUnWelcomePage
    !insertmacro customUnWelcomePage
  !endif
  !insertmacro MUI_UNPAGE_INSTFILES
  !insertmacro MUI_UNPAGE_FINISH
!endif

; ── then languages (mirrors !insertmacro addLangs) ───────────────────────
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; ── then customHeader, where our LangStrings live ────────────────────────
!ifmacrodef customHeader
  !insertmacro customHeader
!endif

Function .onInit
  !ifmacrodef customInit
    !insertmacro customInit
  !endif
FunctionEnd

Section "install"
SectionEnd

Section "Uninstall"
SectionEnd
