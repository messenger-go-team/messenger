FROM golang:1.27.3-alpine AS go-build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY api/gen ./api/gen
COPY internal ./internal
COPY pkg ./pkg
COPY services/auth ./services/auth
COPY services/history ./services/history
COPY cmd/migrate ./cmd/migrate
COPY docs/qa/api-tests/fixture ./docs/qa/api-tests/fixture
RUN CGO_ENABLED=0 go build -o /migrate ./cmd/migrate && CGO_ENABLED=0 go build -o /api-fixture ./docs/qa/api-tests/fixture

FROM node:24.16.0-bookworm-slim
WORKDIR /workspace/docs/qa/api-tests
COPY docs/qa/api-tests/package.json docs/qa/api-tests/package-lock.json ./
RUN npm ci --ignore-scripts && npm audit --audit-level=moderate
COPY --from=go-build /migrate /usr/local/bin/migrate
COPY --from=go-build /api-fixture /usr/local/bin/api-fixture
COPY services/auth/migrations /workspace/services/auth/migrations
COPY services/history/migrations /workspace/services/history/migrations
COPY api/openapi /workspace/api/openapi
COPY docs/qa/api-tests ./
USER 65532:65532
CMD ["npm", "test"]
