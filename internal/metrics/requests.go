package metrics

import (
	"context"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Requests records completed application operations for one service and transport.
type Requests struct {
	total    *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

func NewRequests(service, transport string) *Requests {
	labels := []string{"operation", "result"}
	return &Requests{
		total: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: service,
			Subsystem: transport,
			Name:      "requests_total",
			Help:      "Number of completed application requests.",
		}, labels),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: service,
			Subsystem: transport,
			Name:      "request_duration_seconds",
			Help:      "Application request duration in seconds.",
		}, labels),
	}
}

func (m *Requests) Collectors() []prometheus.Collector {
	return []prometheus.Collector{m.total, m.duration}
}

// ObserveHTTP expects a registered ServeMux pattern. Only method-qualified
// application routes are counted, including rejections inside their middleware.
func (m *Requests) ObserveHTTP(pattern string, statusCode int, aborted bool, duration time.Duration) {
	switch pattern {
	case "GET /metrics", "GET /healthz", "GET /readyz":
		return
	}
	if !strings.Contains(pattern, " ") {
		return
	}

	var result string
	switch {
	case aborted:
		result = "aborted"
	case statusCode >= 200 && statusCode < 300:
		result = "2xx"
	case statusCode >= 300 && statusCode < 400:
		result = "3xx"
	case statusCode >= 400 && statusCode < 500:
		result = "4xx"
	case statusCode >= 500 && statusCode < 600:
		result = "5xx"
	default:
		result = "other"
	}
	m.record(pattern, result, duration)
}

// UnaryServerInterceptor measures the registered application service after
// downstream interceptors have translated errors into their final gRPC codes.
func (m *Requests) UnaryServerInterceptor(service grpc.ServiceDesc) grpc.UnaryServerInterceptor {
	methods := make(map[string]struct{}, len(service.Methods))
	for _, method := range service.Methods {
		methods["/"+service.ServiceName+"/"+method.MethodName] = struct{}{}
	}

	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		response, err := handler(ctx, req)
		if _, ok := methods[info.FullMethod]; ok {
			result, ok := status.FromError(err)
			if !ok {
				result = status.FromContextError(err)
			}
			code := result.Code()
			if code > codes.Unauthenticated {
				code = codes.Unknown
			}
			m.record(info.FullMethod, code.String(), time.Since(start))
		}
		return response, err
	}
}

func (m *Requests) record(operation, result string, duration time.Duration) {
	m.total.WithLabelValues(operation, result).Inc()
	m.duration.WithLabelValues(operation, result).Observe(duration.Seconds())
}
