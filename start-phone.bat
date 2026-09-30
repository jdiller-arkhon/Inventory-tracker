@echo off
REM Start the inventory tracker so phones on your Wi-Fi can connect (for taking photos).
cd /d "%~dp0"
where py >nul 2>nul && (py app.py --phone %*) || (python app.py --phone %*)
pause
