FROM golang:1.27.3-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local

COPY go.mod go.sum ./
RUN go mod download

COPY internal ./internal
COPY pkg ./pkg
COPY services/auth ./services/auth
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /auth ./services/auth

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /auth /auth
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/auth"]
