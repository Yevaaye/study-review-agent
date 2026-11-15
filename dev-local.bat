@echo off
setlocal EnableDelayedExpansion
REM ==========================================================================
REM  学习复盘 Agent — 本地启动器（双击即用）
REM  作用：自动把 WorkBuddy 自带的 Node 24 塞进 PATH，
REM        规避系统 PowerShell 默认 Node 18 过低导致
REM        "Next.js requires Node >=20.9.0" 的报错。然后 npm run dev。
REM ==========================================================================

set "NODE24="
REM 按优先级找 Node 24 所在目录（哪个存在用哪个）
for %%D in (
  "%USERPROFILE%\.workbuddy\binaries\node\versions\24.14.0"
  "C:\Users\Yevaa~\.workbuddy\binaries\node\versions\24.14.0"
  "C:\Users\Yevaa\.workbuddy\binaries\node\versions\24.14.0"
) do (
  if exist "%%D\node.exe" set "NODE24=%%D"
)

if not defined NODE24 (
  echo [错误] 找不到 Node 24。请确认 WorkBuddy 已安装，或把 Node 24+ 目录写进本脚本顶部。
  pause
  exit /b 1
)

echo 使用 Node 目录: %NODE24%
set "PATH=%NODE24%;%PATH%"

cd /d "%~dp0"
echo Node: & node -v
echo npm: & npm -v
echo.
echo ===========================================================
echo  服务器即将启动，监听 0.0.0.0:3000
echo  电脑本机:  http://localhost:3000
echo  手机访问:  http://192.168.31.178:3000   (同 WiFi 下)
echo  后端模式:  本地文件 (DATA_BACKEND=local，自带 7 个知识点)
echo ===========================================================
echo.
echo  [注意] 手机若连不上，多半是 Windows 防火墙挡了 3000 端口。
echo         请用「管理员 PowerShell」执行一次：
echo         netsh advfirewall firewall add rule name="Next3000" dir=in action=allow protocol=TCP localport=3000
echo.
echo  [注意] 若 WiFi 重连后电脑 IP 变了，用 ipconfig 查「WLAN → IPv4」替换上面的地址。
echo.
npm run dev
