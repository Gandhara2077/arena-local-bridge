param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\dist\ArenaLocalBridge.exe')
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '..\launcher\ArenaLocalBridge.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) {
  throw 'The Windows .NET Framework 4.x compiler is missing. No runtime is downloaded; build on Windows with .NET Framework installed.'
}
if (-not (Test-Path -LiteralPath $source)) { throw "Launcher source is missing: $source" }
$target = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$target" $source
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed (exit $LASTEXITCODE)." }
Write-Output $target
