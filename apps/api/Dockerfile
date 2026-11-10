FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/authz ./packages/authz
COPY packages/agent-tools ./packages/agent-tools
COPY packages/domain ./packages/domain

USER node

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
