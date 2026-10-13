FROM node:24-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml* ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY frontend/ ./
RUN npx --no-install vite build

FROM node:24-alpine
ARG GIT_SHA=dev
ENV CC_GIT_SHA=$GIT_SHA
WORKDIR /app
COPY package.json protocols.mjs server.mjs ./
COPY scripts/ ./scripts/
COPY lib/ ./lib/
COPY --from=frontend /build/frontend/dist ./frontend/dist
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3050 3051
HEALTHCHECK --interval=30s --timeout=3s --start-period=8s --retries=3 CMD wget --spider -q http://127.0.0.1:3050/health || exit 1
CMD ["node", "server.mjs"]
