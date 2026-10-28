param(
  [Parameter(Mandatory)][ValidateSet('x64','arm64')][string]$Architecture,
  [Parameter(Mandatory)][string]$Out,
  [string]$SourceSha,
  [switch]$InstallDependencies,
  [switch]$PauseForUi
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
Set-Location -LiteralPath $repo
$sha = (git rev-parse HEAD).Trim()
if ($SourceSha -and $sha -cne $SourceSha) { throw 'Source SHA mismatch' }
if (git status --porcelain --untracked-files=normal) { throw 'Build requires a clean source checkout' }
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
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','build')
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','typecheck')
Invoke-Node @('--test','scripts/stage-daemon.test.mjs','scripts/package-windows.test.mjs','scripts/windows-runtime-smoke.test.mjs','scripts/publish-windows.test.mjs')
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','test','-w','@vonvon/daemon','--','test/environment-windows-launch.test.ts','test/provider/windows-command-line.test.ts','test/provider/windows-supervisor.test.ts','test/windows-owned-process.test.ts','test/data-compatibility.test.ts','test/register-bot.test.ts')
Invoke-Node @('scripts/windows-build-tools.mjs','npm',$envFile,'run','test','-w','@vonvon/desktop','--','test/windows-updates.test.ts','test/tray.test.ts','test/daemon-dependencies.test.ts')
$runtime = Join-Path $outPath 'electron-runtime'
Invoke-Node @('scripts/windows-build-tools.mjs','electron',$Architecture,$runtime)
$version = (& node --input-type=module -e "import {checkedProductVersion} from './scripts/product-version.mjs'; console.log(await checkedProductVersion())").Trim()
if ($LASTEXITCODE -ne 0) { throw 'Version check failed' }
$configFile = Join-Path $outPath 'electron-builder.json'
$packages = Join-Path $outPath 'packages'
@{ extends = (Join-Path $repo 'packages/desktop/electron-builder.yml'); electronDist = $runtime; directories = @{ output = $packages } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding utf8NoBOM
Invoke-Node @('scripts/windows-build-tools.mjs','package',$envFile,$configFile,$Architecture)
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache'
$compiler = Get-ChildItem -LiteralPath $cache -Recurse -File -Filter makensis.exe | Sort-Object FullName | Select-Object -First 1
$plugin = Get-ChildItem -LiteralPath $cache -Recurse -File -Filter StdUtils.dll | Where-Object { $_.Directory.Name -eq 'x86-unicode' } | Sort-Object FullName | Select-Object -First 1
if (-not $compiler -or -not $plugin) { throw 'NSIS tools missing' }
Invoke-Node @('scripts/windows-installer-smoke.mjs',$compiler.FullName,(Join-Path $repo 'node_modules/app-builder-lib/templates/nsis/include'),$plugin.Directory.FullName)
$zip = Join-Path $packages "Vonvon-Bot-$version-windows-$Architecture.zip"
$expanded = Join-Path $outPath 'zip'
Expand-Archive -LiteralPath $zip -DestinationPath $expanded
$zipExe = @(Get-ChildItem -LiteralPath $expanded -Recurse -File -Filter 'Vonvon Bot.exe')
if ($zipExe.Count -ne 1) { throw 'ZIP application is ambiguous' }
$unpacked = Join-Path $packages $(if ($Architecture -eq 'x64') {'win-unpacked'} else {'win-arm64-unpacked'})
$unpackedExe = Join-Path $unpacked 'Vonvon Bot.exe'
$update = Get-Content -LiteralPath 'packages/desktop/stage/dist/windows-update-config.json' -Raw | ConvertFrom-Json
if (@($update.PSObject.Properties).Count -ne 0) { throw 'Unsigned candidate must have updates disabled' }
foreach ($exe in @($unpackedExe, $zipExe[0].FullName)) {
  if ((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -notmatch "^$([regex]::Escape($version))(\.0)?$") { throw 'Packaged application version mismatch' }
  if ((Get-AuthenticodeSignature -LiteralPath $exe).Status -ne 'NotSigned') { throw 'Expected unsigned application' }
}
if ((Get-FileHash -LiteralPath $unpackedExe).Hash -ne (Get-FileHash -LiteralPath $zipExe[0].FullName).Hash) { throw 'ZIP application differs from unpacked application' }
Invoke-Node @('scripts/windows-build-tools.mjs','probe',$unpackedExe,$Architecture)
Invoke-Node @('scripts/windows-runtime-smoke.mjs',(Split-Path $zipExe[0].FullName))
$installer = Join-Path $packages "Vonvon-Bot-Setup-$version-$Architecture.exe"
if ((Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'NotSigned') { throw 'Expected unsigned installer' }
$acceptArgs = @{ Installer = $installer; Evidence = (Join-Path $outPath 'acceptance'); Architecture = $Architecture; SourceSha = $sha }
if ($PauseForUi) { $acceptArgs.PauseForUi = $true }
& (Join-Path $PSScriptRoot 'accept-windows.ps1') @acceptArgs
Invoke-Node @('scripts/package-windows.mjs',$packages,$sha,(Join-Path $unpacked 'Vonvon Bot.exe'),$zipExe[0].FullName,$Architecture)
Copy-Item -LiteralPath (Join-Path $outPath 'acceptance/acceptance.json') -Destination (Join-Path $packages "windows-acceptance-$Architecture.json")
if ((git rev-parse HEAD).Trim() -cne $sha -or (git status --porcelain --untracked-files=normal)) { throw 'Source changed during build' }
Write-Output "BUILD AND ACCEPTANCE PASSED: $version $Architecture $sha"
