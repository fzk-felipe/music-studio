# Instalador do pipeline de vídeos de música (msc)
# Verifica/instala Node.js e FFmpeg via winget e registra o comando "msc".
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ""
Write-Host "=== Instalação: canais de música (msc) ===" -ForegroundColor Cyan
Write-Host "Pasta: $root"
Write-Host ""

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
$hasWinget = Has 'winget'

function Install-Pkg($id, $name, $url) {
  if (-not $hasWinget) {
    Write-Host "  winget não encontrado. Instale $name manualmente: $url" -ForegroundColor Yellow
    return $false
  }
  Write-Host "  instalando $name via winget..." -ForegroundColor Yellow
  winget install --id $id -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  return $true
}

# 1) Node.js 20+
$nodeOk = $false
if (Has 'node') {
  $major = [int]((node -v).TrimStart('v').Split('.')[0])
  $nodeOk = $major -ge 20
  if ($nodeOk) { Write-Host "  Node $(node -v) ok" -ForegroundColor Green }
  else { Write-Host "  Node $(node -v) é antigo (precisa 20+)" -ForegroundColor Yellow }
}
if (-not $nodeOk) { Install-Pkg 'OpenJS.NodeJS.LTS' 'Node.js LTS' 'https://nodejs.org' | Out-Null }

# 2) FFmpeg (build "full", que tem todos os filtros usados)
if (Has 'ffmpeg') { Write-Host "  FFmpeg ok ($((ffmpeg -hide_banner -version | Select-Object -First 1)))" -ForegroundColor Green }
else { Install-Pkg 'Gyan.FFmpeg' 'FFmpeg (full)' 'https://www.gyan.dev/ffmpeg/builds/ (ffmpeg-release-full)' | Out-Null }

# 3) Comando "msc" disponível em qualquer pasta (opcional)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $root) {
  $ans = Read-Host "Adicionar esta pasta ao PATH para usar 'msc' de qualquer lugar? (S/n)"
  if ($ans -eq '' -or $ans -match '^[sSyY]') {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $root), 'User')
    Refresh-Path
    Write-Host "  ok — abra um terminal novo para usar 'msc'" -ForegroundColor Green
  }
}

# 4) Atalhos do app (janela própria, sem a janela preta) na Área de Trabalho e no Menu Iniciar
try {
  foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $folder 'Music Studio.lnk'))
    $sc.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $sc.Arguments = '"' + (Join-Path $root 'msc-studio.vbs') + '"'
    $sc.WorkingDirectory = $root
    $sc.IconLocation = (Join-Path $root 'src\app\icon.ico') + ',0'
    $sc.Description = 'Music Studio: vídeos longos de música'
    $sc.Save()
  }
  Write-Host "  atalho 'Music Studio' criado na Área de Trabalho e no Menu Iniciar" -ForegroundColor Green
} catch { Write-Host "  não consegui criar o atalho (use msc-studio.vbs ou abrir-app.cmd)" -ForegroundColor Yellow }

# 5) Diagnóstico
Write-Host ""
Write-Host "=== Verificando ===" -ForegroundColor Cyan
if (-not (Has 'node') -or -not (Has 'ffmpeg')) {
  Write-Host "Node ou FFmpeg ainda não aparecem neste terminal. Feche esta janela, abra outra e rode instalar.cmd de novo." -ForegroundColor Yellow
  exit 1
}
node "$root\src\cli.mjs" verificar
