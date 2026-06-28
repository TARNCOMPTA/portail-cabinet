@echo off
title Changer un mot de passe - Portail Cabinet
cd /d "%~dp0"
set "NODE=C:\Users\Dell\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"

echo === Changer le mot de passe d'un utilisateur ===
echo.
set /p EMAIL="E-mail de l'utilisateur : "
set /p PWD="Nouveau mot de passe (8 caracteres min.) : "
echo.
"%NODE%" changer-mdp.js "%EMAIL%" "%PWD%"
echo.
pause
