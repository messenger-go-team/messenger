# Static SPA for staging/production behind the public ingress (#46).
# Build: docker build -f web/Dockerfile -t messenger-web:local web
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Same-origin SPA: MSW off (also in .env.production). Override via --build-arg if needed.
ARG VITE_API_MOCK=false
ARG VITE_API_BASE_URL=
ARG VITE_WS_ORIGIN=
ENV VITE_API_MOCK=$VITE_API_MOCK \
    VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_WS_ORIGIN=$VITE_WS_ORIGIN
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# default.conf listens on 8080 (non-root-friendly in many meshes; image still starts as root master).
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
