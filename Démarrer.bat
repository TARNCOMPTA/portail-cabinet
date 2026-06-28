@echo off
title Impots pro - Avis CFE et taxe fonciere
cd /d "%~dp0"

set "NODE=C:\Users\Dell\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "BROWSEROPENED=0"

echo Demarrage du serveur Impots pro... (laissez cette fenetre ouverte)
echo Adresse : http://localhost:3003
echo.

:boucle
rem --- Applique une mise a jour en attente (node est arrete : aucun fichier verrouille) ---
if exist "app_update\server.js" (
  echo Application de la mise a jour...
  xcopy /E /Y /I "app_update\*" "." >nul
  rmdir /S /Q "app_update"
  echo Mise a jour appliquee.
)
if exist "restart.flag" del /Q "restart.flag" >nul 2>&1

rem --- Ouvre le navigateur une seule fois ---
if "%BROWSEROPENED%"=="0" (
  set "BROWSEROPENED=1"
  start "" cmd /c "timeout /t 3 >nul & start http://localhost:3003"
)

rem --- Lance le serveur (bloquant) ---
"%NODE%" --disable-warning=ExperimentalWarning server.js

rem --- Si une mise a jour a ete demandee, on reapplique et relance ---
if exist "app_update\server.js" goto boucle
if exist "restart.flag" goto boucle

pause
