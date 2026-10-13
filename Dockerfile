FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node scripts ./scripts
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir -r scripts/requirements-promotion.txt -r scripts/requirements-oauth.txt
ENV PATH="/app/.venv/bin:$PATH"
ENV PROMOTION_PYTHON=/app/.venv/bin/python V2_OAUTH_PROBE_PYTHON=/app/.venv/bin/python
USER node
EXPOSE 8790
CMD ["node", "dist/server/server/server.js"]
