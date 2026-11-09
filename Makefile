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
