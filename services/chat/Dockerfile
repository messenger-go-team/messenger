FROM golang:1.27.3-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local

COPY go.mod go.sum ./
RUN go mod download

COPY api/gen ./api/gen
COPY internal ./internal
COPY pkg ./pkg
COPY services/chat ./services/chat
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /chat ./services/chat

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /chat /chat
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/chat"]
