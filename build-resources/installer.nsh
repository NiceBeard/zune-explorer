; Custom NSIS installer hooks for Zune Explorer
; Runs after main installation to stage the WinUSB driver for Zune devices.
; pnputil stages the driver into the Windows driver store so it's automatically
; applied next time a Zune is plugged in.

!macro customInstall
  DetailPrint "Staging Zune USB driver (WinUSB)..."
  nsExec::ExecToLog '"$SYSDIR\pnputil.exe" /add-driver "$INSTDIR\resources\zune-winusb.inf" /install'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Note: Zune USB driver staging returned exit code $0 — you may need to install it manually."
  ${EndIf}
!macroend

!macro customUninstall
  ; Nothing to do on uninstall — the staged driver remains in the Windows driver
  ; store, which is the expected behavior. Users can remove it via Device Manager.
!macroend
