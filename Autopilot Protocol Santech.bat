@echo off
title Autopiloto Protocol Santech - Capa 1
REM Doble clic para arrancar. Abre la pestana Protocol Santech y recorre sus visuales de la capa 1.
REM Ctrl+C (o cerrar la ventana) para detenerlo.
set RESOLUME_URL=http://172.20.10.2:8080
set DECK=Protocol Santech
set LAYER=1
set MIN_SECONDS=120
set MAX_SECONDS=180
cd /d "%~dp0"
node dist\autopilot.js
pause
