@echo off
title Panel Resolume - modo local
REM Panel + puente en este PC. Abre en el celular la direccion que aparece (misma red Wi-Fi/hotspot).
cd /d "%~dp0"
if not exist panel-config.bat (
  echo Falta panel-config.bat. Copia panel-config.example.bat como panel-config.bat y pon tus codigos.
  pause
  exit /b 1
)
call panel-config.bat
if not exist dist\local.js (
  echo Compilando el panel por primera vez...
  call npm install && call npm run build || (pause & exit /b 1)
)
node dist\local.js
pause
