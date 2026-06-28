@echo off
title Creation du compte administrateur - Portail Cabinet
cd /d "%~dp0"
set "NODE=C:\Users\Dell\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

echo === Creation du premier compte administrateur ===
echo.
set /p EMAIL="E-mail : "
set /p NOM="Nom (Prenom NOM) : "
set /p PWD="Mot de passe (8 caracteres min.) : "
echo.
"%NODE%" creer-admin.js "%EMAIL%" "%NOM%" "%PWD%"
echo.
pause
