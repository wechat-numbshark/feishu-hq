FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# worker 复用 packages/domain 的持久作业队列等单一事实源实现；
# ai_scheduled_run 动态 import apps/api/src/ai.ts（含 packages/authz、agent-tools），需一并复制
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

USER node

CMD ["node", "--experimental-strip-types", "apps/worker/src/main.ts"]
