param([Parameter(Mandatory)][string]$Output)
$ErrorActionPreference = 'Stop'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$source = Join-Path $PSScriptRoot 'source-offline-stage.cpp'
$object = [IO.Path]::ChangeExtension($Output, '.obj')
$command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /W4 /WX /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" crypt32.lib bcrypt.lib advapi32.lib' -f $vcvars, $object, $Output, $source
& cmd.exe /s /c $command
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw 'Private native stage fixture compilation failed' }
Remove-Item -LiteralPath $object
