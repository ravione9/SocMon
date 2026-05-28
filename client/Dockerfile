# bookworm-slim: glibc + stable npm — avoids intermittent "Exit handler never called" on alpine during Docker builds
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Corporate SSL inspection: set NPM_STRICT_SSL=false at build time (see docker-compose.yml).
ARG NPM_STRICT_SSL=true

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NODE_OPTIONS=--max-old-space-size=4096

COPY package.json package-lock.json ./
RUN if [ "$NPM_STRICT_SSL" = "false" ]; then npm config set strict-ssl false; fi \
  && npm ci --no-audit --no-fund --progress=false

COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
