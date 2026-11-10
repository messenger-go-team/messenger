GO ?= go
SERVICE ?= _template
# Keep this version aligned with .github/workflows/ci.yml.
GOLANGCI_LINT ?= $(GO) run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
# Go's ./... skips directories beginning with "_".
GO_PACKAGES := ./... ./services/_template

.PHONY: build lint test

build:
	mkdir -p bin
	$(GO) build -o "bin/$(SERVICE)" "./services/$(SERVICE)"

lint:
	$(GOLANGCI_LINT) run $(GO_PACKAGES)

test:
	CGO_ENABLED=1 $(GO) test -race -count=1 $(GO_PACKAGES)

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
