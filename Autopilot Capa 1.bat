@echo off
title Autopiloto Fiesta Santech - Capa 1
REM Doble clic para arrancar. Ctrl+C (o cerrar la ventana) para detenerlo.
REM Ajusta estos valores si cambia la IP o quieres otros tiempos.
set RESOLUME_URL=http://172.20.10.2:8080
set DECK=Fiesta Santech
set LAYER=1
set MIN_SECONDS=120
set MAX_SECONDS=180
cd /d "%~dp0"
node dist\autopilot.js
pause
