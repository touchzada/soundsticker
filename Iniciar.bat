@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "FIGURINHA_ROOT=%~dp0"
set "PORT=3847"
set "OPEN_BROWSER=1"
set "HOST=127.0.0.1"

if exist "runtime\node.exe" (
  set "NODE=runtime\node.exe"
) else (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Nao achei o Node. Neste pacote ele deveria estar em runtime\node.exe
    pause
    exit /b 1
  )
  set "NODE=node"
)

if exist "app\server.mjs" (
  set "APP=app\server.mjs"
) else (
  set "APP=server.mjs"
)

echo Abrindo Figurinha com Som em http://127.0.0.1:%PORT%
echo Feche esta janela para encerrar o app.
"%NODE%" "%APP%"
if errorlevel 1 (
  echo.
  echo O app encerrou com erro.
  pause
)
