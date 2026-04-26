@echo off
cd /d "C:\Users\62392\Documents\Google\ai-illustration-studio"
set PORT=8080
set ADMIN_TOKEN=123456
set DATA_DIR=C:\Users\62392\Documents\Google\ai-illustration-studio\data
set NOVELAI_API_URL=https://image.novelai.net
set MOCK_WHEN_NO_ACCOUNT=true
"C:\Program Files\nodejs\node.exe" server/index.js 1>>server.out.log 2>>server.err.log
