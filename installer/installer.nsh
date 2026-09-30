!macro customInstall
  ExecWait '"$INSTDIR\resources\runtime\node\node.exe" "$INSTDIR\resources\cli-registration.cjs" install user "$INSTDIR"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Vonvon Bot CLI installation failed. The desktop app can repair it when opened."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ExecWait '"$INSTDIR\resources\runtime\node\node.exe" "$INSTDIR\resources\cli-registration.cjs" remove user "$INSTDIR"' $0
  ${EndIf}
!macroend
