; 0.7.5's deeply nested files exceed the old uninstaller's temporary rename
; path budget. Retry its normal uninstall, retaining existing shortcuts.
; Release 0.7.5 did not enable DELETE_APP_DATA_ON_UNINSTALL. Never pass
; --delete-app-data; /KEEP_APP_DATA is retained for compatibility, not relied on.
; Use the same registered uninstaller electron-builder already invoked.
!include WordFunc.nsh
!ifndef BUILD_UNINSTALLER
  Var vonvonUpdateInstallDir
  ; Assisted installs show the directory page once. Updates use electron-builder's
  ; --updated page skipping and retain the registered current-user directory.
  !macro customInit
    ${If} ${isForAllUsers}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Vonvon Bot only supports installation for the current user." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $hasPerMachineInstallation "0"
    StrCpy $hasPerUserInstallation "1"
    !insertmacro setInstallModePerUser
    ${If} $perUserInstallationFolder == ""
      ReadRegDWORD $R0 HKCU "${INSTALL_REGISTRY_KEY}" VonvonUninstallUsesOriginalDir
      ${If} $R0 != 1
        ReadRegStr $R1 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
        ${If} $R1 != ""
          StrCpy $R2 $R1 1
          ${If} $R2 == '$\"'
            ${WordFind} "$R1" '$\"' "E+1" $R1
          ${Else}
            StrCpy $R1 "$EXEPATH"
          ${EndIf}
          ${If} ${FileExists} "$R1"
            MessageBox MB_OK|MB_ICONEXCLAMATION "Cannot safely locate the old installation. Keep it and contact support. / 无法安全确认旧安装位置，请保留现有安装并联系支持。" /SD IDOK
            SetErrorLevel 2
            Quit
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} ${isUpdated}
      !insertmacro GetDParameter $R0
      ${If} $R0 == ""
      ${AndIf} $perUserInstallationFolder == ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "Cannot locate the existing installation. Please reinstall from the website. / 无法确认原安装位置，请从官网重新安装。" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $vonvonUpdateInstallDir $INSTDIR
    ${EndIf}
  !macroend

  !macro customInstallMode
    StrCpy $isForceMachineInstall "0"
    StrCpy $isForceCurrentInstall "1"
    ${If} ${isUpdated}
      ; The stock mode page rereads InstallLocation. Pin the resolved update
      ; destination so a disappearing registration cannot select the default.
      SetShellVarContext current
      StrCpy $installMode CurrentUser
      StrCpy $INSTDIR $vonvonUpdateInstallDir
      Abort
    ${EndIf}
  !macroend

  !macro customInstall
    WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" VonvonUninstallUsesOriginalDir 1
  !macroend

  ; The assisted template otherwise appends APP_FILENAME even during --updated.
  ; Preserve an existing custom /D path from the old one-click installer exactly.
  !macro customPageAfterChangeDir
    Page custom vonvonCheckDirectory
    Function vonvonCheckDirectory
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      Call instFilesPre
      ; This page is reached only after Next on the directory page. The global
      ; .onVerifyInstDir callback also runs while typing/browsing, so never probe there.
      ClearErrors
      CreateDirectory "$INSTDIR"
      GetTempFileName $R0 "$INSTDIR"
      ${IfNot} ${Errors}
        Delete "$R0"
        Abort
      ${EndIf}
      !insertmacro MUI_HEADER_TEXT "Installation folder / 安装目录" "Choose a writable folder / 请选择可写目录"
      nsDialogs::Create 1018
      Pop $R0
      ${If} $R0 == error
        SetErrorLevel 2
        Quit
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 70u "This folder is not writable by your Windows user. Click Back to choose another folder.$\r$\n$\r$\n当前用户无法写入此目录。请点击上一步，选择其他安装目录。"
      Pop $R0
      GetDlgItem $R0 $HWNDPARENT 1
      EnableWindow $R0 0
      nsDialogs::Show
    FunctionEnd
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
    !define MUI_PAGE_CUSTOMFUNCTION_PRE vonvonInstFilesPre
    Function vonvonInstFilesPre
      ${IfNot} ${isUpdated}
        Call instFilesPre
      ${EndIf}
    FunctionEnd
  !macroend

  !macro customFinishPage
    Function vonvonStartApp
      ; common.nsh's StartApp declares a global variable on every expansion;
      ; installSection.nsh already expands it for silent assisted upgrades.
      Push $0
      Push $1
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
      Pop $1
      Pop $0
    FunctionEnd
    Function vonvonFinishPre
      ${If} ${isUpdated}
        ${If} ${isForceRun}
          Call vonvonStartApp
        ${EndIf}
        Abort
      ${EndIf}
    FunctionEnd
    !define MUI_PAGE_CUSTOMFUNCTION_PRE vonvonFinishPre
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION vonvonStartApp
    !insertmacro MUI_PAGE_FINISH
  !macroend

!else
  !macro customUnInit
    ; The NSIS stub validates _? and un.onInit stores it in OUTDIR before the
    ; stock initMultiUser overwrites INSTDIR using the possibly missing registry.
    ${IfNot} ${FileExists} "$OUTDIR\${UNINSTALL_FILENAME}"
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} ${isUpdated}
    ${AndIfNot} ${FileExists} "$OUTDIR\${APP_EXECUTABLE_FILENAME}"
      SetErrorLevel 2
      Quit
    ${EndIf}
    SetShellVarContext current
    StrCpy $installMode CurrentUser
    StrCpy $INSTDIR $OUTDIR
    StrCpy $perUserInstallationFolder $OUTDIR
  !macroend

  !macro customInstallMode
    StrCpy $isForceMachineInstall "0"
    StrCpy $isForceCurrentInstall "1"
    SetShellVarContext current
    StrCpy $installMode CurrentUser
    StrCpy $INSTDIR $OUTDIR
    Abort
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
  Var vonvonPreviousUninstaller
  Var vonvonPreviousInstallDir
!endif

!macro recoverLegacyWindowsUninstall
  ${If} ${Errors}
  ${AndIf} $R0 == 0
    StrCpy $R0 2
    ; electron-builder also sets Errors when a stale registration points at
    ; an uninstaller which no longer exists. Nothing needs uninstalling only
    ; when BOTH that uninstaller and the old application executable are gone.
    ; Re-read the same registry view: electron-builder declares its internal
    ; uninstaller variables AFTER expanding this hook, so do not reference them.
    ; Use the old registration's directory, not the new /D destination.
    ${If} $installMode == "CurrentUser"
      ReadRegStr $vonvonPreviousUninstaller HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
      !ifdef UNINSTALL_REGISTRY_KEY_2
        ${If} $vonvonPreviousUninstaller == ""
          ReadRegStr $vonvonPreviousUninstaller HKCU "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
        ${EndIf}
      !endif
      !insertmacro GetInQuotes $vonvonPreviousUninstaller "$vonvonPreviousUninstaller"
      StrCpy $vonvonPreviousInstallDir $perUserInstallationFolder
      ${If} $vonvonPreviousInstallDir == ""
      ${AndIf} $vonvonPreviousUninstaller != ""
        Push $vonvonPreviousUninstaller
        Call GetFileParent
        Pop $vonvonPreviousInstallDir
      ${EndIf}
      ${If} $vonvonPreviousUninstaller != ""
      ${AndIf} $vonvonPreviousInstallDir != ""
      ${AndIfNot} ${FileExists} "$vonvonPreviousUninstaller"
      ${AndIfNot} ${FileExists} "$vonvonPreviousInstallDir\${APP_EXECUTABLE_FILENAME}"
        ClearErrors
        StrCpy $R0 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $R0 != 0
  ${AndIf} $installMode == "CurrentUser"
  ${AndIf} $perUserInstallationFolder != ""
    ClearErrors
    GetDLLVersion "$perUserInstallationFolder\${APP_EXECUTABLE_FILENAME}" $R1 $R2
    ${IfNot} ${Errors}
    ${AndIf} $R1 == 7
    ${AndIf} $R2 == 327680
      ClearErrors
      ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA --keep-shortcuts /currentuser _?=$perUserInstallationFolder' $R0
      ${If} ${Errors}
        StrCpy $R0 2
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro recoverLegacyWindowsUninstall
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro recoverLegacyWindowsUninstall
!macroend
