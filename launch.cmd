@echo off
REM Lampa-Stream launcher for Windows (dev / from-source).
REM On Windows the electron npm binary just works (no LD_LIBRARY_PATH needed).
REM
REM TorrServer must be running for the "Торренты" source to work.
REM First run will ask for a TMDB Read Access Token.

cd /d "%~dp0"
node_modules\electron\dist\electron.exe . %*
