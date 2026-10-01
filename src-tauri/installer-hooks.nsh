; Tauri's NSIS template creates the Start Menu entry but not a desktop
; shortcut, so add one here and take it away again on uninstall.
; $INSTDIR is %LOCALAPPDATA%\Sheet Nesting Estimator (currentUser install mode),
; and the binary keeps the Cargo package name rather than the product name.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$DESKTOP\Sheet Nesting Estimator.lnk" "$INSTDIR\sheet-nesting-estimator.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\Sheet Nesting Estimator.lnk"
!macroend
