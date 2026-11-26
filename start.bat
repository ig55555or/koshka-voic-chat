@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo Первый запуск: устанавливаю зависимости...
  python -m venv .venv || goto :err
  .venv\Scripts\python.exe -m pip install -q -r requirements.txt || goto :err
)
.venv\Scripts\python.exe server.py %*
pause
exit /b
:err
echo Ошибка. Установите Python 3.10+ с python.org (галочка "Add to PATH").
pause
