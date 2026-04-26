Set-Location 'C:\Users\62392\Documents\Google\ai-illustration-studio'
$env:PORT='8080'
$env:ADMIN_TOKEN='123456'
$env:NOVELAI_API_URL='https://image.novelai.net'
$env:MOCK_WHEN_NO_ACCOUNT='true'
node server/index.js *> server.combined.log
