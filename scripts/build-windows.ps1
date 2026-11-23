param(
  [Parameter(Mandatory)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory)][string]$Out,
  [string]$SourceSha,
  [switch]$InstallDependencies,
  [switch]$PackageOnly,
  [switch]$PauseForUi
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
Set-Location -LiteralPath $repo
if ((& node -p 'process.versions.node').Trim() -ne '24.22.1') { throw 'Use pinned Node.js 24.22.1 for reproducible Windows builds' }
$sha = (git rev-parse HEAD).Trim()
if ($SourceSha -and $sha -cne $SourceSha) { throw 'Source SHA mismatch' }
function Assert-CleanSource {
  if ((git rev-parse HEAD).Trim() -cne $sha) { throw 'Source HEAD changed during build' }
  # npm relinks bin scripts with LF on Windows. Compare normalized blobs rather
  # than stat-only porcelain dirtiness from a CRLF checkout; no source edits pass.
  git diff --quiet HEAD --
  if ($LASTEXITCODE -ne 0 -or (git ls-files --others --exclude-standard)) { throw 'Build requires unchanged tracked source and no untracked files' }
  git diff --cached --quiet HEAD --
  if ($LASTEXITCODE -ne 0) { throw 'Build refuses staged source changes' }
}
Assert-CleanSource
$outPath = [IO.Path]::GetFullPath($Out)
if (-not [IO.Path]::IsPathRooted($Out) -or $outPath.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase) -or $outPath -eq $repo) { throw 'Use an absolute dedicated output directory outside the source checkout' }
if ((Test-Path -LiteralPath $outPath) -and (Get-ChildItem -LiteralPath $outPath -Force)) { throw 'Output directory must be new or empty' }
New-Item -ItemType Directory -Path $outPath -Force | Out-Null
function Invoke-Node([string[]]$Arguments) {
  & node @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Node command failed: $($Arguments[0])" }
}
$buildHome = Join-Path $outPath 'build-home'
New-Item -ItemType Directory -Path $buildHome | Out-Null
# HOME belongs only to child build processes. git/gh keep the normal account.
$envFile = Join-Path $outPath 'build-env.json'
@{ home = $buildHome; repo = $repo } | ConvertTo-Json | Set-Content -LiteralPath $envFile -Encoding utf8NoBOM
if ($InstallDependencies) { Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'ci') }
# Compile the actual installer pages and launch tail before expensive product builds.
Invoke-Node @('scripts/windows-installer-compile.mjs',(Join-Path $outPath 'installer-compile'),$Architecture)
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','build')
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','typecheck')
Invoke-Node @('--test','scripts/stage-daemon.test.mjs','scripts/package-windows.test.mjs','scripts/windows-runtime-smoke.test.mjs','scripts/windows-supervisor-runtime.test.mjs','scripts/publish-windows.test.mjs')
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','test','-w','@vonvon/daemon','--','test/rich-recipe-files.test.ts','test/environment-windows-launch.test.ts','test/provider/windows-command-line.test.ts','test/provider/windows-supervisor.test.ts','test/windows-owned-process.test.ts','test/card-display-scripts.test.ts','test/card-display-validation.test.ts','test/card-display-render.test.ts','test/data-compatibility.test.ts','test/register-bot.test.ts','test/locate.test.ts','test/codex-version.test.ts','test/codex-managed-install.test.ts','test/codex-source.test.ts','test/appserver-pool.test.ts','test/environment-rpc.test.ts','test/codex-environment-install.test.ts','test/codex-windows-backend.test.ts','test/admin-ipc.test.ts','test/codex-catalog-cache.test.ts','test/claude-model-discovery.test.ts','test/codex-setup.test.ts','test/provider-model-discovery.test.ts','test/provider-models-rpc.test.ts','test/codex-model-discovery.test.ts','test/server-snapshot.test.ts','test/dm-project.test.ts','test/dm-upgrade.test.ts','test/dm-directory-recovery.test.ts','test/server-state.test.ts','test/host-library-startup.test.ts','test/atomic-file-windows.test.ts','test/project-atomic-windows.test.ts')
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','test','-w','@vonvon/desktop','--','test/windows-updates.test.ts','test/updates.test.ts','test/tray.test.ts','test/daemon-dependencies.test.ts','test/windows-cli-registration.test.ts','test/windows-cli-path.test.ts')
Assert-CleanSource
$runtime = Join-Path $outPath 'electron-runtime'
Invoke-Node @('scripts/windows-build-tools.mjs','electron',$Architecture,$runtime)
$version = (& node --input-type=module -e "import {checkedProductVersion} from './scripts/product-version.mjs'; console.log(await checkedProductVersion())").Trim()
if ($LASTEXITCODE -ne 0) { throw 'Version check failed' }
$configFile = Join-Path $outPath 'electron-builder.json'
$packages = Join-Path $outPath 'packages'
@{ extends = (Join-Path $repo 'packages/desktop/electron-builder.yml'); electronDist = $runtime; directories = @{ output = $packages } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding utf8NoBOM
Invoke-Node @('scripts/windows-build-tools.mjs','package',$envFile,$configFile,$Architecture)
# This pinned builder emits latest.yml for a standalone Windows ARM64 build.
# Give it a distinct name before merging the two architecture directories.
if ($Architecture -eq 'arm64') {
  $rawFeed = Join-Path $packages 'latest.yml'
  $armFeed = Join-Path $packages 'latest-arm64.yml'
  if ((Test-Path -LiteralPath $rawFeed) -and -not (Test-Path -LiteralPath $armFeed)) {
    if ([IO.Path]::GetFullPath((Split-Path $armFeed)) -cne [IO.Path]::GetFullPath($packages)) { throw 'Unexpected feed destination' }
    Move-Item -LiteralPath $rawFeed -Destination $armFeed -ErrorAction Stop
  }
}
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache'
$compiler = Get-ChildItem -LiteralPath $cache -Recurse -File -Filter makensis.exe | Sort-Object FullName | Select-Object -First 1
$plugin = Get-ChildItem -LiteralPath $cache -Recurse -File -Filter StdUtils.dll | Where-Object { $_.Directory.Name -eq 'x86-unicode' } | Sort-Object FullName | Select-Object -First 1
if (-not $compiler -or -not $plugin) { throw 'NSIS tools missing' }
Invoke-Node @('scripts/windows-installer-smoke.mjs',$compiler.FullName,(Join-Path $repo 'node_modules/app-builder-lib/templates/nsis/include'),$plugin.Directory.FullName)
$unpacked = Join-Path $packages $(if ($Architecture -eq 'x64') {'win-unpacked'} else {'win-arm64-unpacked'})
$unpackedExe = Join-Path $unpacked 'Vonvon Bot.exe'
$update = Get-Content -LiteralPath 'packages/desktop/stage/dist/windows-update-config.json' -Raw | ConvertFrom-Json
if (@($update.PSObject.Properties).Count -ne 1 -or -not $update.publicKey) { throw 'Windows candidate must embed its update verification public key' }
foreach ($exe in @($unpackedExe)) {
  if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -notmatch "^$([regex]::Escape($version))(\.0)?$") { throw 'Packaged application version mismatch' }
  if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'NotSigned') { throw 'Expected unsigned application' }
}
Invoke-Node @('scripts/windows-build-tools.mjs','probe',$unpackedExe,$Architecture)
Invoke-Node @('scripts/windows-runtime-smoke.mjs',$unpacked)
$installer = Join-Path $packages "Vonvon-Bot-Setup-$version-$Architecture.exe"
if ((Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'NotSigned') { throw 'Expected unsigned installer' }
if ($PackageOnly) {
  # Development handoff only: no product registry, shortcuts or installed app is touched.
  # No release inventory/native acceptance report is produced, so publication cannot consume this output.
  @{ version = $version; sourceSha = $sha; architecture = $Architecture; installer = $installer; acceptancePending = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outPath 'development-package.json') -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $outPath 'DO-NOT-PUBLISH') -Value 'Development package: native installation acceptance is pending.'
  Assert-CleanSource
  Write-Output "DEVELOPMENT PACKAGE ONLY: $version $Architecture $sha"
  return
}
$acceptArgs = @{ Installer = $installer; Evidence = (Join-Path $outPath 'acceptance'); Architecture = $Architecture; SourceSha = $sha; ReferenceDirectory = $unpacked }
if ($PauseForUi) { $acceptArgs.PauseForUi = $true }
& (Join-Path $PSScriptRoot 'accept-windows.ps1') @acceptArgs
Invoke-Node @('scripts/package-windows.mjs',$packages,$sha,(Join-Path $unpacked 'Vonvon Bot.exe'),$Architecture,(Join-Path $repo 'packages/desktop/stage/dist/windows-update-config.json'))
Copy-Item -LiteralPath (Join-Path $outPath 'acceptance/acceptance.json') -Destination (Join-Path $packages "windows-acceptance-$Architecture.json")
Assert-CleanSource
Write-Output "BUILD AND ACCEPTANCE PASSED: $version $Architecture $sha"
