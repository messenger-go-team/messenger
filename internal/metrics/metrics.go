// Package metrics exposes the base runtime/process metrics used by each service.
package metrics

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// NewHandler creates an endpoint with its own registry. Call it once per service.
func NewHandler() http.Handler {
	return promhttp.HandlerFor(newRegistry(), promhttp.HandlerOpts{})
}

func newRegistry() *prometheus.Registry {
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return registry
}
