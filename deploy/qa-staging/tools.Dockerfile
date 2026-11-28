FROM golang:1.27.3-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download
COPY api/gen ./api/gen
COPY cmd/migrate ./cmd/migrate
COPY deploy/qa-staging/faults ./deploy/qa-staging/faults
RUN CGO_ENABLED=0 go build -trimpath -o /migrate ./cmd/migrate \
    && CGO_ENABLED=0 go build -trimpath -o /qa-faults ./deploy/qa-staging/faults

FROM postgres:18-alpine
ARG QA_REVISION
LABEL org.opencontainers.image.revision=$QA_REVISION
WORKDIR /opt/qa
COPY --from=build /migrate /qa-faults /usr/local/bin/
COPY services/auth/migrations ./services/auth/migrations
COPY services/history/migrations ./services/history/migrations
COPY --chmod=755 deploy/qa-staging/init.sh ./init.sh
COPY deploy/qa-staging/init.sql ./init.sql
