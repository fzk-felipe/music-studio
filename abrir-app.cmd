@echo off
chcp 65001 >nul
title Music Studio
node "%~dp0src\cli.mjs" app
if errorlevel 1 pause
