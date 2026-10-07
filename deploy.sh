#!/bin/bash
set -e

# BSC Meme 跟单执行器一键部署脚本
# 运行前请确保：
# 1. 已购买 VPS 并拿到 root 密码/SSH key
# 2. 已把域名 A 记录指向该 VPS 的公网 IP
# 3. 已把 .env 文件内容准备好（不要提交到 git）

DOMAIN="${DOMAIN:-webhook.example.com}"
EMAIL="${EMAIL:-your-email@example.com}"
APP_DIR="/opt/automeme"
REPO_URL="https://github.com/yourusername/automeme.git"  # 如需部署，改成实际仓库

echo "===== 1. 更新系统 ====="
apt-get update && apt-get upgrade -y

echo "===== 2. 安装 Node.js 22 ====="
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v
npm -v

echo "===== 3. 安装依赖工具 ====="
apt-get install -y git nginx certbot python3-certbot-nginx ufw build-essential python3
npm install -g pm2

echo "===== 4. 部署项目 ====="
# 如果已有项目目录，先备份
if [ -d "$APP_DIR" ]; then
  mv "$APP_DIR" "${APP_DIR}.bak.$(date +%s)"
fi

# 从当前目录复制，排除 node_modules 和日志
mkdir -p "$APP_DIR"
rsync -av \
  --exclude='node_modules' \
  --exclude='frontend/node_modules' \
  --exclude='dist' \
  --exclude='dist-frontend' \
  --exclude='logs' \
  --exclude='.git' \
  "$(pwd)/" "$APP_DIR/"
cd "$APP_DIR"

# 安装主依赖
npm ci

# 安装前端依赖
cd frontend && npm ci && cd ..

# 构建TS，构建前端 Vue3
npm run build
npm run build:frontend

echo "===== 5. 配置 .env ====="
# 提示用户手动放 .env
if [ ! -f ".env" ]; then
  echo "警告：未找到 .env 文件，请手动上传后重启服务"
fi

echo "===== 6. 配置 PM2 ====="
pm2 delete automeme-webhook 2>/dev/null || true
pm2 start node --name automeme-webhook -- dist/src/webhook-server.js
pm2 save
pm2 startup systemd -u root --hp /root

echo "===== 7. 配置防火墙 ====="
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "===== 8. 配置 Nginx ====="
cat > /etc/nginx/sites-available/automeme <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # SSE 长连接支持
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/automeme /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "===== 9. 配置 SSL ====="
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

echo "===== 部署完成 ====="
echo "Webhook URL: https://$DOMAIN/webhook"
echo "Dashboard:   https://$DOMAIN/"
echo ""
echo "常用命令："
echo "  查看日志：pm2 logs automeme-webhook"
echo "  重启服务：pm2 restart automeme-webhook"
echo "  查看状态：pm2 status"
