param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$Evidence,
  [Parameter(Mandatory)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory)][string]$SourceSha,
  [Parameter(Mandatory)][string]$ReferenceDirectory,
  [switch]$PauseForUi
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($Installer) -or -not [IO.Path]::IsPathRooted($Evidence) -or -not [IO.Path]::IsPathRooted($ReferenceDirectory)) { throw 'Installer, reference and evidence paths must be absolute' }
if ($SourceSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Use a complete source SHA' }
if (Test-Path -LiteralPath (Join-Path $Evidence 'acceptance.json')) { throw 'Acceptance report already exists' }
New-Item -ItemType Directory -Path $Evidence -Force | Out-Null
$lockPath = Join-Path ([IO.Path]::GetTempPath()) 'vonvon-installer-acceptance.lock'
$lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('vva-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $scratch | Out-Null
$scratch = [IO.Path]::GetFullPath($scratch)
$installDir = Join-Path $scratch 'app'
$data = Join-Path $scratch 'data'
New-Item -ItemType Directory -Path $data | Out-Null
$sentinel = Join-Path $data 'acceptance-sentinel'
Set-Content -LiteralPath $sentinel -Value 'preserve isolated data' -Encoding utf8NoBOM
$guid = '112b66fd-a3da-518d-bedf-d190fc603918'
$keys = @("Software\$guid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
$views = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)
$saved = @()
$savedFiles = @()
$steps = @()
$referencePe = @(Get-ChildItem -LiteralPath $ReferenceDirectory -File -Recurse | Where-Object { $_.Extension -in @('.exe','.dll','.node') } | ForEach-Object { @{ path = [IO.Path]::GetRelativePath($ReferenceDirectory,$_.FullName); hash = (Get-FileHash -LiteralPath $_.FullName).Hash } })
if (-not ($referencePe | Where-Object { $_.path -eq 'Vonvon Bot.exe' })) { throw 'Reference payload does not contain the application' }
$started = [DateTime]::UtcNow.ToString('o')
$restorable = $false
$paths = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Vonvon Bot.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Vonvon Bot.lnk'),
  (Join-Path $env:LOCALAPPDATA 'vonvon-bot-desktop-updater\installer.exe')
)
function Wait-Condition([scriptblock]$Condition, [string]$Failure) {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (-not (& $Condition)) { if ([DateTime]::UtcNow -gt $deadline) { throw $Failure }; Start-Sleep -Milliseconds 300 }
}
function Run-Installer {
  Assert-OwnedRegistration
  $p = Start-Process -FilePath $Installer -ArgumentList @('/currentuser','/S',"/D=$installDir") -PassThru -Wait -WindowStyle Hidden
  if ($p.ExitCode -ne 0) { throw "Installer failed: $($p.ExitCode)" }
  Wait-Condition { Test-Path -LiteralPath (Join-Path $installDir 'Uninstall Vonvon Bot.exe') } 'Installed files were not ready'
  $installedFiles = @(Get-ChildItem -LiteralPath $installDir -Force | Select-Object -ExpandProperty Name)
  $installedFiles | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence 'installed-files.json') -Encoding utf8NoBOM
  if (-not (Test-Path -LiteralPath (Join-Path $installDir 'Vonvon Bot.exe'))) { throw 'Installer did not extract the application executable' }
  foreach ($pe in $referencePe) {
    $file = Join-Path $installDir $pe.path
    if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file).Hash -cne $pe.hash) { throw "Installed PE missing or changed: $($pe.path)" }
  }
}
function Assert-OwnedRegistration {
  foreach ($view in $views) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', $view)
    try {
      $key = $base.OpenSubKey($keys[0]); $location = if ($key) { $key.GetValue('InstallLocation') }; if ($key) { $key.Close() }
      $key = $base.OpenSubKey($keys[1]); $command = if ($key) { $key.GetValue('UninstallString') }; if ($key) { $key.Close() }
      if ($location -and -not $location.StartsWith($scratch + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Concurrent installation detected; preserve evidence and stop restoration' }
      if ($command -and ($command -notmatch '^"([^"]+)"' -or -not $Matches[1].StartsWith($scratch + '\',[StringComparison]::OrdinalIgnoreCase))) { throw 'Concurrent uninstall registration detected; preserve evidence and stop restoration' }
    } finally { $base.Close() }
  }
}
function Uninstall-Candidate {
  Assert-OwnedRegistration
  $uninstaller = Join-Path $installDir 'Uninstall Vonvon Bot.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    $p = Start-Process -FilePath $uninstaller -ArgumentList @('/currentuser','/S',"/D=$installDir") -PassThru -Wait -WindowStyle Hidden
    if ($p.ExitCode -ne 0) { throw "Uninstaller failed: $($p.ExitCode)" }
    Wait-Condition { -not (Test-Path -LiteralPath (Join-Path $installDir 'Vonvon Bot.exe')) } 'Uninstaller left the application executable'
  }
}
function Check-Runtime([string]$Name) {
  & node (Join-Path $PSScriptRoot 'windows-runtime-smoke.mjs') $installDir $data | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { throw "Installed runtime failed: $Name" }
  if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -ne 'preserve isolated data') { throw 'Isolated data was changed' }
  # PowerShell functions have their own scope; return the case to the caller.
  return @{ name = $Name; passed = $true }
}
try {
  foreach ($view in $views) {
    $machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', $view)
    try { foreach ($keyPath in $keys) { $key = $machine.OpenSubKey($keyPath); if ($key) { $key.Close(); throw 'Machine-wide product registration detected; acceptance refused' } } } finally { $machine.Close() }
  }
  # Snapshot ONLY this product's two keys in each view. Refuse a real existing
  # installation, so /D never invokes an owner's working application uninstaller.
  foreach ($view in $views) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', $view)
    try {
      foreach ($keyPath in $keys) {
        $key = $base.OpenSubKey($keyPath)
        $values = @()
        if ($key) {
          try {
            if ($key.SubKeyCount) { throw 'Unexpected product registry subkeys; inspect manually' }
            foreach ($name in $key.GetValueNames()) {
              $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
              if (($name -eq 'InstallLocation' -and ((Test-Path -LiteralPath (Join-Path $value 'Vonvon Bot.exe')) -or (Test-Path -LiteralPath (Join-Path $value 'Uninstall Vonvon Bot.exe')))) -or
                  ($name -eq 'UninstallString' -and $value -match '^"([^"]+)"' -and ((Test-Path -LiteralPath $Matches[1]) -or (Test-Path -LiteralPath (Join-Path (Split-Path $Matches[1]) 'Vonvon Bot.exe'))))) { throw 'Existing application installation detected; acceptance refused' }
              $values += @{ name = $name; kind = $key.GetValueKind($name); value = $value }
            }
          } finally { $key.Close() }
        }
        $saved += @{ view = $view; path = $keyPath; existed = ($null -ne $key); values = $values }
      }
    } finally { $base.Close() }
  }
  foreach ($path in $paths) {
    $exists = Test-Path -LiteralPath $path
    $backup = Join-Path $Evidence ("saved-file-$($savedFiles.Count)")
    if ($exists) { Copy-Item -LiteralPath $path -Destination $backup }
    $savedFiles += @{ path = $path; existed = $exists; backup = $backup }
  }
  $saved | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Evidence 'registry-backup.json') -Encoding utf8NoBOM
  $restorable = $true
  foreach ($entry in $saved) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', $entry.view)
    try { $base.DeleteSubKeyTree($entry.path, $false) } finally { $base.Close() }
  }
  Run-Installer
  $steps += Check-Runtime 'fresh-install'
  if ($PauseForUi) {
    @{ executable = (Join-Path $installDir 'Vonvon Bot.exe'); home = $data; desktopHome = (Join-Path $scratch 'desktop') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Evidence 'ui-ready.json') -Encoding utf8NoBOM
    Write-Output "UI CHECK READY: $Evidence"
    $deadline = [DateTime]::UtcNow.AddMinutes(10)
    $continue = Join-Path $Evidence 'ui-continue.json'
    while (-not (Test-Path -LiteralPath $continue)) { if ([DateTime]::UtcNow -gt $deadline) { throw 'Local UI check timed out' }; Start-Sleep -Seconds 1 }
    if (-not (Get-Content -LiteralPath $continue -Raw | ConvertFrom-Json).passed) { throw 'Local UI check did not pass' }
    $steps += @{ name = 'desktop-onboarding-observed'; passed = $true }
  }
  Run-Installer
  $steps += Check-Runtime 'overwrite-install'
  Uninstall-Candidate
  $steps += @{ name = 'uninstall'; passed = $true }
  Run-Installer
  $steps += Check-Runtime 'reinstall-after-uninstall'
  Uninstall-Candidate
  # Recreate the reported 0.7.5 orphan using a missing path INSIDE our scratch.
  foreach ($view in $views) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', $view)
    try {
      $key = $base.CreateSubKey($keys[0]); $key.SetValue('InstallLocation', (Join-Path $scratch 'legacy-missing')); $key.Close()
      $key = $base.CreateSubKey($keys[1]); $key.SetValue('DisplayVersion','0.7.5'); $key.SetValue('UninstallString', ('"' + (Join-Path $scratch 'legacy-missing\Uninstall Vonvon Bot.exe') + '" /currentuser')); $key.Close()
    } finally { $base.Close() }
  }
  Run-Installer
  $steps += Check-Runtime 'reinstall-after-0.7.5-orphan'
  Uninstall-Candidate
  $report = @{ sourceSha = $SourceSha; architecture = $Architecture; hostArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant(); installerSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant(); startedAt = $started; completedAt = [DateTime]::UtcNow.ToString('o'); steps = $steps; passed = $true; verifiedPeFiles = $referencePe.Count; dataScope = 'Isolated VONVON_HOME retained across runtime and reinstall; default profile data not exercised' }
} finally {
  $cleanupErrors = @()
  $restoreAllowed = $restorable
  try {
    if ($restorable) {
      # Check before the uninstaller can delete any registry key or shortcut.
      try { Assert-OwnedRegistration } catch { $restoreAllowed = $false; $cleanupErrors += $_ }
      if ($restoreAllowed) {
        try { Uninstall-Candidate } catch { $cleanupErrors += $_ }
        # A failed test uninstaller must not skip restoration of unrelated state.
        try { Assert-OwnedRegistration } catch { $restoreAllowed = $false; $cleanupErrors += $_ }
        if ($restoreAllowed) {
          foreach ($entry in $saved) {
            try {
              $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', $entry.view)
              try {
                $base.DeleteSubKeyTree($entry.path, $false)
                if ($entry.existed) { $key = $base.CreateSubKey($entry.path); try { foreach ($v in $entry.values) { $key.SetValue($v.name,$v.value,$v.kind) } } finally { $key.Close() } }
              } finally { $base.Close() }
            } catch { $cleanupErrors += $_ }
          }
          foreach ($file in $savedFiles) {
            try {
              if ($file.existed) { New-Item -ItemType Directory -Path (Split-Path $file.path) -Force | Out-Null; Copy-Item -LiteralPath $file.backup -Destination $file.path -Force }
              elseif (Test-Path -LiteralPath $file.path) { [IO.File]::Delete($file.path) }
            } catch { $cleanupErrors += $_ }
          }
        }
      }
    }
    # Recursively remove only the verified scratch created above in this run.
    if ([IO.Path]::GetFullPath($scratch) -notmatch '\\vva-[a-f0-9]{8}$') { throw 'Unexpected scratch path' }
    if (-not $restorable -or $restoreAllowed) {
      try { Remove-Item -LiteralPath $scratch -Recurse -Force } catch { $cleanupErrors += $_ }
    }
  } finally { $lock.Dispose() }
  if ($cleanupErrors.Count) { throw "Acceptance cleanup failed; backups remain in $Evidence. $($cleanupErrors -join '; ')" }
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Evidence 'acceptance.json') -Encoding utf8NoBOM
