; 0.7.5's deeply nested files exceed the old uninstaller's temporary rename
; path budget. Retry its normal uninstall, retaining existing shortcuts.
; Release 0.7.5 did not enable DELETE_APP_DATA_ON_UNINSTALL. Never pass
; --delete-app-data; /KEEP_APP_DATA is retained for compatibility, not relied on.
; Use the same registered uninstaller electron-builder already invoked.
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
