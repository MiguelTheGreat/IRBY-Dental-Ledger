# Creates ocr-model\.venv and installs the OCR model's Python packages (RapidOCR, OpenCV,
# Keras / TensorFlow). IRBY Dental Ledger starts this interpreter automatically afterwards.
#
#   powershell -ExecutionPolicy Bypass -File ocr-model\setup-ocr.ps1
#   powershell -ExecutionPolicy Bypass -File ocr-model\setup-ocr.ps1 -Python "C:\Python311\python.exe"
param([string]$Python = "")
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venv = Join-Path $here ".venv"

function Invoke-Py([string[]]$cmd, [string[]]$more) {
    $exe = $cmd[0]
    $pre = @()
    if ($cmd.Length -gt 1) { $pre = $cmd[1..($cmd.Length - 1)] }
    & $exe @($pre + $more)
}

function Test-Python([string[]]$cmd) {
    try {
        $v = Invoke-Py $cmd @("-c", "import sys; print('%d.%d' % sys.version_info[:2])") 2>$null
        return ($LASTEXITCODE -eq 0) -and ("$v" -match '^3\.(10|11|12|13)$')
    } catch { return $false }
}

$cmd = $null
if ($Python) { $cmd = @($Python) }
else {
    foreach ($c in @(@("py", "-3.12"), @("py", "-3.11"), @("py", "-3.10"), @("python"), @("py", "-3"))) {
        if (Test-Python $c) { $cmd = $c; break }
    }
}
if (-not $cmd) {
    Write-Error "Python 3.10 - 3.12 was not found. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') and run this script again."
}

Write-Host "Creating $venv with: $($cmd -join ' ')"
Invoke-Py $cmd @("-m", "venv", $venv)
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install -r (Join-Path $here "requirements.txt")
Write-Host "Checking the model loads..."
& $py (Join-Path $here "infer.py") --health
Write-Host "Done. Start IRBY Dental Ledger normally; it launches the OCR server from $py."
