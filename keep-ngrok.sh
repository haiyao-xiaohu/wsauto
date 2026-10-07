#!/bin/bash
# ngrok 守护进程 - 断线自动重连
echo "[keep-ngrok] 启动守护，按 Ctrl+C 退出"
while true; do
  echo "[keep-ngrok] $(date '+%H:%M:%S') 启动 ngrok..."
  ngrok http 8080
  echo "[keep-ngrok] $(date '+%H:%M:%S') ngrok 退出，5 秒后重连..."
  sleep 5
done
