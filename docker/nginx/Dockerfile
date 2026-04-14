# Optional: single image with UI baked in (requires a working `npm ci` inside Docker).
# Default production flow uses docker-compose.prod.yml with ./client/dist mounted into nginx.
#
# docker build -f docker/nginx/Dockerfile -t netpulse-nginx .

FROM node:20-bookworm-slim AS client-build
WORKDIR /app
COPY client/package*.json ./
ENV npm_config_audit=false
ENV npm_config_fund=false
RUN npm ci && test -x node_modules/.bin/vite
COPY client/ ./
ARG VITE_API_URL=
ARG VITE_WS_URL=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
RUN npm run build && test -f dist/index.html

FROM nginx:1.27-alpine
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=client-build /app/dist /usr/share/nginx/html
