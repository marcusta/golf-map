# Closes or starts Unity (the course project) and Arborist, so GSPro has the graphics card to
# itself while frame rates are measured (verified 2026-10-13):
#   pwsh unity/ArboristMod/apps.ps1 close      both closed (Unity saves nothing: save the scene first)
#   pwsh unity/ArboristMod/apps.ps1 start      both started; Arborist comes up with no course loaded
# Unity closes on a window-close request. Arborist answers one with an "are you sure" dialog, so
# it is stopped outright (the same as its "Yes": nothing of ours is ever saved from Arborist).
# Arborist starts with Unity's configuration dialog, whose default button (Play!) takes Enter.
param([Parameter(Mandatory)][ValidateSet('close', 'start')][string]$Action,
      [string]$UnityProject = 'D:\gspro_courses\vreta_v4_2025_12_02',
      [string]$Unity = 'C:\Program Files\Unity\Hub\Editor\2018.2.8f1\Editor\Unity.exe',
      [string]$Arborist = 'D:\gspro\Arborist_Launcher\Data\Application\Arborist.exe')
if ($Action -eq 'close') {
    Get-Process Unity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { [void]$_.CloseMainWindow() }
    Get-Process Arborist -ErrorAction SilentlyContinue | Stop-Process -Force
    for ($i = 0; $i -lt 60 -and (Get-Process Unity -ErrorAction SilentlyContinue); $i++) { Start-Sleep 2 }
    if (Get-Process Unity -ErrorAction SilentlyContinue) { Write-Output 'Unity is still open (a dialog? unsaved scene?).'; exit 1 }
    Write-Output 'Unity and Arborist are closed.'
} else {
    if (-not (Get-Process Unity -ErrorAction SilentlyContinue)) { Start-Process $Unity -ArgumentList '-projectPath', $UnityProject }
    if (-not (Get-Process Arborist -ErrorAction SilentlyContinue)) {
        Start-Process $Arborist -WorkingDirectory (Split-Path $Arborist)
        $shell = New-Object -ComObject WScript.Shell
        for ($i = 0; $i -lt 30; $i++) { Start-Sleep 1; if ($shell.AppActivate('Arborist Configuration')) { Start-Sleep -Milliseconds 600; $shell.SendKeys('{ENTER}'); break } }
    }
    Write-Output 'Started. Unity needs a minute or two before its bridge answers (bun unity/mcp/call.ts golfmap.vsp.trees).'
}
