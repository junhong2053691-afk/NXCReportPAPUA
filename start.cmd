@echo off
cd /d "%~dp0"
node check-node.js
call npm install
node server/index.js
pause
