GO ?= go
SERVICE ?= _template
MIGRATE_SERVICE ?= all
MIGRATE_STEPS ?= 1
# Keep this version aligned with .github/workflows/ci.yml.
GOLANGCI_LINT ?= $(GO) run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.15.0
# Go's ./... skips directories beginning with "_".
GO_PACKAGES := ./... ./services/_template

.PHONY: build lint test migrate-up migrate-down migrate-version

build:
	mkdir -p bin
	$(GO) build -o "bin/$(SERVICE)" "./services/$(SERVICE)"

lint:
	$(GOLANGCI_LINT) run $(GO_PACKAGES)

test:
	CGO_ENABLED=1 $(GO) test -race -count=1 $(GO_PACKAGES)

migrate-up:
	$(GO) run ./cmd/migrate -service=$(MIGRATE_SERVICE) -direction=up

migrate-down:
	$(GO) run ./cmd/migrate -service=$(MIGRATE_SERVICE) -direction=down -steps=$(MIGRATE_STEPS)

migrate-version:
	$(GO) run ./cmd/migrate -service=$(MIGRATE_SERVICE) -direction=version
