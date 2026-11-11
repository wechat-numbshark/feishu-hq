# 开发与部署

需要 Node.js 22+、npm，以及 Docker Desktop / Docker Engine 或 PostgreSQL 16。

## Docker 启动

复制 `deploy/compose/.env.example` 为 `deploy/compose/.env`，填写随机密码和会话密钥，然后运行：

```bash
npm ci
docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml up -d
docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml ps
```

迁移容器会应用 `database/migrations/` 中的 SQL；访问 `http://localhost:3000`。本地体验请在 `.env` 中设置 `DEMO_MODE=true`、`TRUST_PROXY=false`、`COOKIE_SECURE=false`。公开部署前应关闭演示模式，恢复 HTTPS 所需的安全 Cookie，并配置 HTTPS、强随机密钥、备份和访问控制。

## 单独运行

将根目录 `.env.example` 复制为 `.env` 并填写数据库连接信息，然后执行：

```bash
npm ci
npm run check
npm test
npm run dev:api
npm run dev:worker
```

飞书/Lark SSO 需要在开发者后台创建自己的企业应用，设置回调 `https://你的域名/v1/feishu/callback`，并把 App ID、App Secret 写入运行环境。不要把这些值提交到 Git。版本升级前请先备份 PostgreSQL；迁移按编号追加。
