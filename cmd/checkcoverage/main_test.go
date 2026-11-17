package main

import (
	"bytes"
	"errors"
	"io"
	"math"
	"path/filepath"
	"strings"
	"testing"
)

func TestCoverageGate(t *testing.T) {
	for _, tc := range []struct {
		name, profile string
		packages      []string
		minimum       float64
		valid         bool
	}{
		{"exact threshold", "mode: atomic\nmodule/service/a.go:1.1,2.2 6 1\nmodule/service/b.go:1.1,2.2 4 0\n", []string{"./service"}, 60, true},
		{"weighted statements", "mode: count\nmodule/service/a.go:1.1,2.2 6 9\nmodule/service/a.go:3.1,4.2 4 0\n", []string{"service"}, 60, true},
		{"below threshold", "mode: atomic\nmodule/service/a.go:1.1,2.2 5 1\nmodule/service/a.go:3.1,4.2 5 0\n", []string{"service"}, 60, false},
		{"rounding cannot pass", "mode: atomic\nmodule/service/a.go:1.1,2.2 1499 1\nmodule/service/a.go:3.1,4.2 1001 0\n", []string{"service"}, 60, false},
		// A well-covered neighbour cannot hide an untested business package.
		{"separate packages", "mode: set\nmodule/service/a.go:1.1,2.2 100 1\nmodule/other/a.go:1.1,2.2 1 0\n", []string{"service", "other"}, 60, false},
		{"missing package", "mode: atomic\nmodule/service/a.go:1.1,2.2 6 1\n", []string{"service", "missing"}, 60, false},
		{"no prefix confusion", "mode: atomic\nmodule/service_extra/a.go:1.1,2.2 6 1\n", []string{"service"}, 60, false},
		{"empty profile", "", []string{"service"}, 60, false},
		{"header only", "mode: atomic\n", []string{"service"}, 60, false},
		{"bad header", "mode: broken\n", []string{"service"}, 60, false},
		{"bad record", "mode: atomic\nbroken\n", []string{"service"}, 60, false},
		{"bad source", "mode: atomic\nfile 1 1\n", []string{"service"}, 60, false},
		{"bad number", "mode: atomic\nmodule/service/a.go:1.1,2.2 x 1\n", []string{"service"}, 60, false},
		{"negative executions", "mode: atomic\nmodule/service/a.go:1.1,2.2 1 -1\n", []string{"service"}, 60, false},
		{"missing scope", "mode: atomic\n", nil, 60, false},
		{"duplicate scope", "mode: atomic\n", []string{"service", "./service"}, 60, false},
		{"absolute scope", "mode: atomic\n", []string{"/service"}, 60, false},
		{"invalid minimum", "mode: atomic\n", []string{"service"}, 101, false},
		{"NaN minimum", "mode: atomic\n", []string{"service"}, math.NaN(), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := checkCoverage(strings.NewReader(tc.profile), tc.minimum, tc.packages, &out)
			if (err == nil) != tc.valid {
				t.Fatal(out.String(), err)
			}
			if tc.valid && !strings.Contains(out.String(), "6/10 statements") {
				t.Fatal("wrong weighted coverage", out.String())
			}
		})
	}
}

type failedWriter struct{}

func (failedWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }
func TestCoverageIOFailures(t *testing.T) {
	if err := run(filepath.Join(t.TempDir(), "absent.out"), 60, []string{"service"}, io.Discard); err == nil {
		t.Fatal("missing profile accepted")
	}
	profile := "mode: atomic\nmodule/service/a.go:1.1,2.2 1 1\n"
	if err := checkCoverage(strings.NewReader(profile), 60, []string{"service"}, failedWriter{}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal(err)
	}
	if err := checkCoverage(strings.NewReader("mode: atomic\n"+strings.Repeat("x", 100000)), 60, []string{"service"}, io.Discard); err == nil {
		t.Fatal("truncated profile accepted")
	}
}
