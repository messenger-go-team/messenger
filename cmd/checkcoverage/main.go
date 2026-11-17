// Command checkcoverage enforces unit coverage for each explicitly scoped package.
package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"strconv"
	"strings"
)

type coverage struct{ covered, total int64 }

func main() {
	profile := flag.String("profile", "coverage.unit.out", "Go coverage profile")
	minimum := flag.Float64("min", 60, "minimum statement coverage per package")
	flag.Parse()
	if err := run(*profile, *minimum, flag.Args(), os.Stdout); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(profile string, minimum float64, packages []string, output io.Writer) error {
	f, err := os.Open(profile)
	if err != nil {
		return fmt.Errorf("open coverage profile: %w", err)
	}
	defer func() { _ = f.Close() }()
	return checkCoverage(f, minimum, packages, output)
}

func checkCoverage(input io.Reader, minimum float64, packages []string, output io.Writer) error {
	if len(packages) == 0 || math.IsNaN(minimum) || math.IsInf(minimum, 0) || minimum < 0 || minimum > 100 {
		return errors.New("require packages and a coverage minimum in 0..100")
	}
	stats := make(map[string]coverage, len(packages))
	for _, pkg := range packages {
		name := strings.TrimPrefix(pkg, "./")
		if name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") || strings.HasPrefix(name, "../") {
			return fmt.Errorf("invalid package scope %q", pkg)
		}
		if _, exists := stats[name]; exists {
			return fmt.Errorf("duplicate package %s", name)
		}
		stats[name] = coverage{}
	}
	scanner := bufio.NewScanner(input)
	if !scanner.Scan() || (scanner.Text() != "mode: set" && scanner.Text() != "mode: count" && scanner.Text() != "mode: atomic") {
		return errors.New("invalid coverage profile header")
	}
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 {
			return errors.New("invalid coverage record")
		}
		colon := strings.LastIndexByte(fields[0], ':')
		if colon < 0 || !strings.HasSuffix(fields[0][:colon], ".go") {
			return errors.New("invalid coverage source")
		}
		n, err := strconv.ParseInt(fields[1], 10, 32)
		if err != nil || n < 0 {
			return errors.New("invalid statement count")
		}
		count, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil || count < 0 {
			return errors.New("invalid execution count")
		}
		dir := path.Dir(fields[0][:colon])
		for pkg, value := range stats {
			if dir != pkg && !strings.HasSuffix(dir, "/"+pkg) {
				continue
			}
			value.total += n
			if count > 0 {
				value.covered += n
			}
			stats[pkg] = value
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read coverage profile: %w", err)
	}
	var failed bool
	for _, scope := range packages {
		pkg := strings.TrimPrefix(scope, "./")
		value := stats[pkg]
		// Missing packages must fail: an empty/truncated profile is not 100%.
		if value.total == 0 {
			return fmt.Errorf("no statements measured for %s", pkg)
		}
		percent := 100 * float64(value.covered) / float64(value.total)
		if _, err := fmt.Fprintf(output, "%s: %.1f%% (%d/%d statements; minimum %.1f%%)\n", pkg, percent, value.covered, value.total, minimum); err != nil {
			return err
		}
		// Compare before display rounding; 59.96% must not pass a 60% gate.
		failed = failed || percent < minimum
	}
	if failed {
		return errors.New("service unit coverage is below the required minimum")
	}
	return nil
}
