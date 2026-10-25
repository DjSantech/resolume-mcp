@echo off
REM Copia este archivo como panel-config.bat (queda fuera de git) y pon tus valores.

REM Nombre del evento como se verá en el panel, e identificador (solo a-z, 0-9 y -).
set EVENT_NAME=Mi evento
set EVENT_ID=mi-evento

REM Resolume en este mismo PC (recomendado). Si corre en otro PC: http://IP:8080
set RESOLUME_URL=http://127.0.0.1:8080

REM ---- Modo local (Panel Local.bat): códigos para entrar desde el celular.
set ADMIN_CODE=cambia-este-codigo
set VIEWER_CODE=

REM ---- Modo nube (Panel Puente.bat): dirección del servidor desplegado y su BRIDGE_TOKEN.
set SERVER_URL=wss://tu-panel.onrender.com
set BRIDGE_TOKEN=pega-aqui-el-bridge-token

REM Captura de la salida cada N ms mientras alguien mira. Súbelo (p. ej. 8000) si el internet del evento es de datos móviles.
set SNAPSHOT_MS=3000
REM Carpeta "Resolume Arena" (Preferences y Presets), solo si no esta en Documentos. Ejemplo:
REM set RESOLUME_DOCS=D:\Documentos\Resolume Arena
