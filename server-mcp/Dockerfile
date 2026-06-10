# Mirrors server/Dockerfile so corp-proxy SSL workaround works the same way.
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG NPM_STRICT_SSL=true

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

COPY package*.json ./
RUN if [ "$NPM_STRICT_SSL" = "false" ]; then npm config set strict-ssl false; fi \
  && npm install --no-audit --no-fund --progress=false

COPY . .
EXPOSE 5050
CMD ["node", "src/index.js"]
