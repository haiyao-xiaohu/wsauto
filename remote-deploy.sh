#!/bin/bash
set -e
echo "===== 1. 安装 PM2 ====="
npm install -g pm2

echo "===== 2. 进入项目目录 ====="
cd /opt/automeme-src

echo "===== 3. 安装依赖 ====="
npm install

echo "===== 4. 构建项目 ====="
npm run build

echo "===== 5. 启动服务 ====="
pm2 delete automeme-webhook 2>/dev/null || true
pm2 start npm --name automeme-webhook -- run webhook
pm2 save
pm2 startup systemd -u root --hp /root

echo "===== 6. 检查状态 ====="
sleep 3
pm2 status
pm2 logs automeme-webhook --lines 20 --nostream

echo "===== 部署完成 ====="
echo "Dashboard: http://<YOUR_SERVER_IP>:3000/"
