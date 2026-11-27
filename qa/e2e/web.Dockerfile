FROM node:24.16.0-bookworm-slim AS web-build
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/tsconfig*.json web/vite.config.ts web/.env.production ./
COPY web/src ./src
COPY web/mocks ./mocks
RUN npm run build

FROM nginx:alpine
COPY qa/e2e/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/snippets/backends.conf deploy/nginx/snippets/auth-locations.conf /etc/nginx/messenger/snippets/
COPY --from=web-build /src/dist/ /usr/share/nginx/html/app/
