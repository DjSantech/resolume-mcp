@echo off
title Panel Resolume - puente a la nube
REM Conecta este PC (el de Resolume) con el panel desplegado en la nube. Deja la ventana abierta durante el evento.
cd /d "%~dp0"
if not exist panel-config.bat (
  echo Falta panel-config.bat. Copia panel-config.example.bat como panel-config.bat y pon SERVER_URL y BRIDGE_TOKEN.
  pause
  exit /b 1
)
call panel-config.bat
if not exist dist\bridge\main.js (
  echo Compilando el panel por primera vez...
  call npm install && call npm run build || (pause & exit /b 1)
)
node dist\bridge\main.js
pause
