FROM golang:1.27.3-alpine AS build
WORKDIR /src
ENV GOTOOLCHAIN=local

COPY go.mod go.sum ./
RUN go mod download

COPY api/gen ./api/gen
COPY internal ./internal
COPY pkg ./pkg
COPY services/history ./services/history
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /history ./services/history

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /history /history
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/history"]
