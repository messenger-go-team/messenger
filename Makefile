GO ?= go
SERVICE ?= _template
MIGRATE_SERVICE ?=
MIGRATE_STEPS ?= 1
# Keep this version aligned with .github/workflows/ci.yml.
GOLANGCI_LINT ?= $(GO) run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
# Go's ./... skips directories beginning with "_".
GO_PACKAGES := ./... ./services/_template
# Business packages only: adapters, transports and integration tests cannot raise
# the unit-only coverage figure. Extend this list when adding a business package.
SERVICE_UNIT_PACKAGES := ./services/auth/internal/auth \
	./services/history/internal/chats ./services/history/internal/messages \
	./services/history/internal/reading ./services/history/internal/later

.PHONY: build lint test test-unit migrate-up migrate-down migrate-version

build:
	mkdir -p bin
	$(GO) build -o "bin/$(SERVICE)" "./services/$(SERVICE)"

lint:
	$(GOLANGCI_LINT) run $(GO_PACKAGES)

test:
	CGO_ENABLED=1 $(GO) test -race -count=1 $(GO_PACKAGES)

test-unit:
	CGO_ENABLED=1 $(GO) test -race -count=1 -coverprofile=coverage.unit.out $(SERVICE_UNIT_PACKAGES)
	$(GO) tool cover -func=coverage.unit.out
	$(GO) run ./cmd/checkcoverage -profile=coverage.unit.out -min=60 $(SERVICE_UNIT_PACKAGES)

migrate-up:
	$(GO) run ./cmd/migrate -service=$(MIGRATE_SERVICE) -direction=up

migrate-down:
	$(GO) run ./cmd/migrate -service=$(MIGRATE_SERVICE) -direction=down -steps=$(MIGRATE_STEPS)

migrate-version:
	$(GO) run ./cmd/migrate -service=$(MIGRATE_SERVICE) -direction=version
# Tool versions are independent of globally installed protobuf binaries.
BUF_VERSION := v1.72.0
PROTOC_GEN_GO_VERSION := v1.36.12
PROTOC_GEN_GO_GRPC_VERSION := v1.6.2
PROTO_BIN := $(abspath bin/proto)

.PHONY: proto proto-tools

proto-tools:
	mkdir -p "$(PROTO_BIN)"
	GOBIN="$(PROTO_BIN)" $(GO) install github.com/bufbuild/buf/cmd/buf@$(BUF_VERSION)
	GOBIN="$(PROTO_BIN)" $(GO) install google.golang.org/protobuf/cmd/protoc-gen-go@$(PROTOC_GEN_GO_VERSION)
	GOBIN="$(PROTO_BIN)" $(GO) install google.golang.org/grpc/cmd/protoc-gen-go-grpc@$(PROTOC_GEN_GO_GRPC_VERSION)

proto: proto-tools
	"$(PROTO_BIN)/buf" format --diff --exit-code
	"$(PROTO_BIN)/buf" lint
	"$(PROTO_BIN)/buf" generate
