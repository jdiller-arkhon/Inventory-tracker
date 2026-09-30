@echo off
REM Start the inventory tracker (Windows). Opens your browser automatically.
cd /d "%~dp0"
where py >nul 2>nul && (py app.py %*) || (python app.py %*)
pause
