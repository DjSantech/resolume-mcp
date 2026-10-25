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
REM Instala dependencias la primera vez y compila siempre: asi una version nueva descomprimida encima se usa de inmediato.
if not exist node_modules (
  echo Instalando dependencias por primera vez...
  call npm install || (pause & exit /b 1)
)
echo Compilando...
call npm run build || (pause & exit /b 1)
node dist\local.js
pause
