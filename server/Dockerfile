# bookworm-slim: glibc + stable npm — avoids intermittent "Exit handler never called" on alpine during Docker builds
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG NPM_STRICT_SSL=true

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NODE_OPTIONS=--max-old-space-size=4096

COPY package*.json ./
RUN if [ "$NPM_STRICT_SSL" = "false" ]; then npm config set strict-ssl false; fi \
  && npm install --no-audit --no-fund --progress=false

COPY . .
EXPOSE 5000 9229
CMD ["npm", "run", "dev"]
