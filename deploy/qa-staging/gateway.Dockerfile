FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build:staging

FROM nginx:alpine
ARG QA_REVISION
LABEL org.opencontainers.image.revision=$QA_REVISION
COPY --from=build /src/dist/ /srv/www/app/
COPY deploy/qa-staging/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/snippets/auth-locations.conf /etc/nginx/messenger/snippets/
RUN printf '%s\n' "$QA_REVISION" > /srv/www/revision.txt
