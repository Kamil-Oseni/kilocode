param([string] $Output = (Join-Path $env:TEMP 'raya-desktop-semantic.exe'), [switch] $Fixture)
$ErrorActionPreference = 'Stop'
if ($Fixture -and -not $PSBoundParameters.ContainsKey('Output')) {
  $Output = Join-Path $env:TEMP 'raya-desktop-semantic-fixture.exe'
}
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC BuildTools vcvars64.bat is required' }
$source = Join-Path $PSScriptRoot ('..\native\desktop-semantic{0}.cpp' -f $(if ($Fixture) { '-fixture' } else { '' }))
$object = Join-Path $env:TEMP ('raya-desktop-semantic-{0}.obj' -f [guid]::NewGuid().ToString('N'))
$Output = [IO.Path]::GetFullPath($Output)
$symbol = [IO.Path]::ChangeExtension($Output, '.pdb')
New-Item -ItemType Directory -Path (Split-Path -Parent $Output) -Force | Out-Null
$ready = $false
try {
  $command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /Z7 /W4 /WX /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" user32.lib advapi32.lib ole32.lib oleaut32.lib uiautomationcore.lib /link /DEBUG:FULL /INCREMENTAL:NO /PDB:"{4}"' -f $vcvars, $object, $Output, $source, $symbol
  & cmd.exe /s /c $command
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw "Desktop semantic worker compile failed with exit code $LASTEXITCODE" }
  if ($Fixture) { & $Output } else { & $Output --self-test }
  if ($LASTEXITCODE -ne 0) { throw "Desktop semantic worker self-test failed with exit code $LASTEXITCODE" }
  $ready = $true
  Write-Output $Output
} finally {
  Remove-Item -LiteralPath $object -Force -ErrorAction SilentlyContinue
  if (-not $ready) {
    Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
  }
}
