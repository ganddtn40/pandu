; Pandu NSIS uninstall hook.
;
; The application and its data live in different places. Uninstalling keeps
; %USERPROFILE%\.pandu (flights, settings, snapshots, backups) unless the user
; explicitly chooses to delete it here. Silent uninstalls always keep data.
;
; `app/scripts/check-brand.mjs` verifies the product data directory against
; brand.json. This file is installer glue; it cannot import JSON.

!macro NSIS_HOOK_PREUNINSTALL
  IfSilent pandu_keep_data
  MessageBox MB_YESNO|MB_ICONQUESTION "Uninstalling Pandu keeps your flights, settings, snapshots and backups in $PROFILE\.pandu.$\r$\n$\r$\nDelete that folder as well? This cannot be undone." IDYES pandu_delete_data
  Goto pandu_keep_data
  pandu_delete_data:
    RMDir /r "$PROFILE\.pandu"
  pandu_keep_data:
!macroend
