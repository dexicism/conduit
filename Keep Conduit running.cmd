@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\keep-running.ps1" %*
timeout /t 8
