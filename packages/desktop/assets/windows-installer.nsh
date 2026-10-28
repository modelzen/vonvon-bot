; 0.7.5's deeply nested files exceed the old uninstaller's temporary rename
; path budget. Retry its normal uninstall, retaining existing shortcuts.
; Release 0.7.5 did not enable DELETE_APP_DATA_ON_UNINSTALL. Never pass
; --delete-app-data; /KEEP_APP_DATA is retained for compatibility, not relied on.
; Use the same registered uninstaller electron-builder already invoked.
!macro recoverLegacyWindowsUninstall
  ${If} ${Errors}
    StrCpy $R0 2
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
