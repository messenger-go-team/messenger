package metrics

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestUnaryRequestMetricsUseRegisteredMethodsAndBoundedResults(t *testing.T) {
	requests := NewRequests("test", "grpc")
	service := grpc.ServiceDesc{
		ServiceName: "example.TestService",
		Methods:     []grpc.MethodDesc{{MethodName: "Lookup"}},
	}
	intercept := requests.UnaryServerInterceptor(service)
	for _, err := range []error{
		nil,
		status.Error(codes.Unavailable, "private storage details"),
		context.Canceled,
		context.DeadlineExceeded,
		status.Error(codes.Code(99), "nonstandard status value"),
		errors.New("private arbitrary error"),
	} {
		response := new(int)
		info := &grpc.UnaryServerInfo{FullMethod: "/example.TestService/Lookup"}
		got, gotErr := intercept(t.Context(), nil, info, func(context.Context, any) (any, error) {
			return response, err
		})
		if got != response || gotErr != err {
			t.Fatalf("interceptor changed RPC response: %v %v", got, gotErr)
		}
	}
	for _, method := range []string{"/grpc.health.v1.Health/Check", "/example.TestService/private-identifier"} {
		_, _ = intercept(t.Context(), nil, &grpc.UnaryServerInfo{FullMethod: method}, func(context.Context, any) (any, error) {
			return nil, nil
		})
	}

	w := httptest.NewRecorder()
	NewHandler(requests.Collectors()...).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body)
	}
	body := w.Body.String()
	for _, labelsAndCount := range []string{
		`{operation="/example.TestService/Lookup",result="OK"} 1`,
		`{operation="/example.TestService/Lookup",result="Unavailable"} 1`,
		`{operation="/example.TestService/Lookup",result="Canceled"} 1`,
		`{operation="/example.TestService/Lookup",result="DeadlineExceeded"} 1`,
		`{operation="/example.TestService/Lookup",result="Unknown"} 2`,
	} {
		for _, family := range []string{"test_grpc_requests_total", "test_grpc_request_duration_seconds_count"} {
			if !strings.Contains(body, family+labelsAndCount+"\n") {
				t.Errorf("missing %s%s", family, labelsAndCount)
			}
		}
	}
	for _, private := range []string{"private-identifier", "private storage details", "private arbitrary error", "nonstandard status value", "Code(99)", "grpc.health.v1.Health"} {
		if strings.Contains(body, private) {
			t.Errorf("unexpected metric dimension or value %q", private)
		}
	}
}
