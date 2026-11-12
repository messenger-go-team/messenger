package metrics

import (
	"mime"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

func TestNewHandlerExposesBaseMetrics(t *testing.T) {
	for _, name := range []string{"first instance", "second instance"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
			request.Header.Set("Accept", "text/plain; version=0.0.4")
			response := httptest.NewRecorder()
			NewHandler().ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("scrape returned %d: %s", response.Code, response.Body)
			}
			mediaType, _, err := mime.ParseMediaType(response.Header().Get("Content-Type"))
			if err != nil || mediaType != "text/plain" {
				t.Fatalf("unexpected content type: %q (%v)", response.Header().Get("Content-Type"), err)
			}
			parser := expfmt.NewTextParser(model.LegacyValidation)
			families, err := parser.TextToMetricFamilies(response.Body)
			if err != nil {
				t.Fatalf("invalid Prometheus exposition: %v", err)
			}
			for _, name := range []string{
				"go_goroutines", "go_memstats_alloc_bytes",
				"process_cpu_seconds_total", "process_resident_memory_bytes",
			} {
				family := families[name]
				if family == nil || len(family.GetMetric()) == 0 || family.GetHelp() == "" {
					t.Errorf("missing metric family %s", name)
				}
			}
			for _, family := range families {
				for _, metric := range family.GetMetric() {
					for _, label := range metric.GetLabel() {
						if label.GetName() == "request_id" || label.GetName() == "user_id" {
							t.Errorf("unexpected high-cardinality label %s", label.GetName())
						}
					}
				}
			}
		})
	}
}

func TestRegistriesAreIndependent(t *testing.T) {
	first, second := newRegistry(), newRegistry()
	marker := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "test_registry_marker", Help: "Checks registry isolation.",
	})
	first.MustRegister(marker)
	marker.Set(7)
	for _, tt := range []struct {
		name     string
		registry *prometheus.Registry
		want     bool
	}{
		{"first", first, true},
		{"second", second, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			families, err := tt.registry.Gather()
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, family := range families {
				if family.GetName() == "test_registry_marker" {
					found = true
					if family.GetMetric()[0].GetGauge().GetValue() != 7 {
						t.Fatal("marker value changed")
					}
				}
			}
			if found != tt.want {
				t.Fatalf("marker present=%t, want %t", found, tt.want)
			}
		})
	}
}
