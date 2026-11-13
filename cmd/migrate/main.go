// Command migrate applies database migrations owned by auth and history.
package main

import (
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/golang-migrate/migrate/v4"
	migratedb "github.com/golang-migrate/migrate/v4/database"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/joho/godotenv"
	"github.com/lib/pq"
)

const (
	directionUp      = "up"
	directionDown    = "down"
	directionVersion = "version"
)

var services = []string{"auth", "history"}

func main() {
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(os.Stderr, "could not load .env")
		os.Exit(1)
	}

	service := flag.String("service", "", "service migrations: auth, history or all (required for down)")
	direction := flag.String("direction", directionUp, "migration direction: up, down or version")
	steps := flag.Int("steps", 1, "number of migration steps for direction=down")
	flag.Parse()

	if err := run(*service, *direction, *steps); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(service, direction string, steps int) error {
	if service == "" {
		if direction == directionDown {
			return errors.New("down requires explicit service: auth, history or all")
		}
		service = "all"
	}
	targets, err := selectedServices(service)
	if err != nil {
		return err
	}
	if direction != directionUp && direction != directionDown && direction != directionVersion {
		return fmt.Errorf("unknown migration direction %q", direction)
	}
	if direction == directionDown && steps < 1 {
		return fmt.Errorf("steps must be greater than zero")
	}

	config, err := databaseConfigFromEnv()
	if err != nil {
		return err
	}
	// Check every target before all starts deleting data. Each actual down also
	// repeats the check under the same advisory lock used to execute its steps.
	if direction == directionDown {
		for _, target := range targets {
			if err := migrateService(target, "check-down", steps, config); err != nil {
				return err
			}
		}
	}
	for _, target := range targets {
		if err := migrateService(target, direction, steps, config); err != nil {
			return err
		}
	}
	return nil
}

func selectedServices(service string) ([]string, error) {
	if service == "all" {
		return services, nil
	}
	for _, candidate := range services {
		if service == candidate {
			return []string{service}, nil
		}
	}
	return nil, fmt.Errorf("unknown service %q: use auth, history or all", service)
}

type databaseConfig struct {
	host     string
	port     string
	name     string
	user     string
	password string
	sslMode  string
}

func databaseConfigFromEnv() (databaseConfig, error) {
	config := databaseConfig{
		host:     envOrDefault("POSTGRES_HOST", "127.0.0.1"),
		port:     envOrDefault("POSTGRES_PORT", "15432"),
		name:     envOrDefault("POSTGRES_DB", "messenger"),
		user:     envOrDefault("POSTGRES_USER", "messenger"),
		password: os.Getenv("POSTGRES_PASSWORD"),
		sslMode:  envOrDefault("POSTGRES_SSLMODE", "disable"),
	}
	if err := config.validate(); err != nil {
		return databaseConfig{}, err
	}
	return config, nil
}

// Validate without quoting values: connection parameters may themselves contain
// credentials. In particular, lib/pq URL errors can include the complete DSN.
func (c databaseConfig) validate() error {
	if c.password == "" {
		return errors.New("POSTGRES_PASSWORD must be set")
	}
	port, err := strconv.ParseUint(c.port, 10, 16)
	if err != nil || port == 0 || strings.IndexFunc(c.port, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return errors.New("POSTGRES_PORT must be an integer in 1..65535")
	}
	if strings.Contains(c.host, ":") {
		if _, err := netip.ParseAddr(c.host); err != nil {
			return errors.New("POSTGRES_HOST must be a hostname or unbracketed IP address")
		}
	} else if c.host == "" || strings.IndexFunc(c.host, func(r rune) bool {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			return false
		default:
			return true
		}
	}) >= 0 {
		return errors.New("POSTGRES_HOST must be a hostname or unbracketed IP address")
	}
	switch c.sslMode {
	case "disable", "require", "verify-ca", "verify-full":
	default:
		return errors.New("POSTGRES_SSLMODE must be disable, require, verify-ca or verify-full")
	}
	return nil
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func (c databaseConfig) url() string {
	databaseURL := &url.URL{
		Scheme: "postgres",
		Host:   net.JoinHostPort(c.host, c.port),
		Path:   "/" + c.name,
		User:   url.UserPassword(c.user, c.password),
	}
	query := databaseURL.Query()
	query.Set("sslmode", c.sslMode)
	databaseURL.RawQuery = query.Encode()
	return databaseURL.String()
}

func migrateService(service, direction string, steps int, config databaseConfig) (resultErr error) {
	if err := config.validate(); err != nil {
		return err
	}
	migrationsPath, err := filepath.Abs(filepath.Join("services", service, "migrations"))
	if err != nil {
		return fmt.Errorf("resolve %s migrations path: %w", service, err)
	}
	sourceDriver, err := iofs.New(os.DirFS(migrationsPath), ".")
	if err != nil {
		return fmt.Errorf("load %s migrations: %w", service, err)
	}
	defer func() { resultErr = errors.Join(resultErr, sourceDriver.Close()) }()

	connector, err := pq.NewConnector(config.url())
	if err != nil {
		// Never expose a URL parser error: it may embed the password-bearing DSN.
		return fmt.Errorf("invalid %s PostgreSQL connection parameters", service)
	}
	database := sql.OpenDB(connector)
	defer func() {
		resultErr = errors.Join(resultErr, database.Close())
	}()

	driver, err := postgres.WithInstance(database, &postgres.Config{
		SchemaName:      "public",
		MigrationsTable: service + "_schema_migrations",
	})
	if err != nil {
		return fmt.Errorf("create %s migration driver: %w", service, err)
	}

	migrationDriver := migratedb.Driver(driver)
	if direction == directionDown || direction == "check-down" {
		migrationDriver = &checkedDownDriver{Driver: driver, source: sourceDriver, steps: steps}
	}
	if direction == "check-down" {
		defer func() { resultErr = errors.Join(resultErr, driver.Close()) }()
		if err := migrationDriver.Lock(); err != nil {
			return fmt.Errorf("check %s rollback: %w", service, err)
		}
		return migrationDriver.Unlock()
	}
	migration, err := migrate.NewWithInstance("iofs", sourceDriver, service, migrationDriver)
	if err != nil {
		return errors.Join(fmt.Errorf("load %s migrations: %w", service, err), driver.Close())
	}
	defer func() {
		sourceErr, databaseErr := migration.Close()
		resultErr = errors.Join(resultErr, sourceErr, databaseErr)
	}()

	switch direction {
	case directionUp:
		err = migration.Up()
	case directionDown:
		err = migration.Steps(-steps)
	case directionVersion:
		version, dirty, versionErr := driver.Version()
		if versionErr == nil && version == migratedb.NilVersion && !dirty {
			fmt.Printf("%s: no migrations applied\n", service)
			return nil
		}
		if versionErr != nil {
			return fmt.Errorf("read %s migration version: %w", service, versionErr)
		}
		fmt.Printf("%s: version=%d dirty=%t\n", service, version, dirty)
		return nil
	}
	if errors.Is(err, migrate.ErrNoChange) {
		fmt.Printf("%s: no changes\n", service)
		return nil
	}
	if err != nil {
		return fmt.Errorf("apply %s migrations %s: %w", service, direction, err)
	}
	fmt.Printf("%s: %s complete\n", service, direction)
	return nil
}

// Preflight and execution share the PostgreSQL advisory lock. A concurrent
// migrator cannot change the version between counting steps and applying them.
type checkedDownDriver struct {
	migratedb.Driver
	source source.Driver
	steps  int
}

func (d *checkedDownDriver) Lock() error {
	if err := d.Driver.Lock(); err != nil {
		return err
	}
	if err := d.check(); err != nil {
		return errors.Join(err, d.Unlock())
	}
	return nil
}

func (d *checkedDownDriver) check() error {
	version, dirty, err := d.Version()
	if err != nil {
		return err
	}
	if dirty {
		return migrate.ErrDirty{Version: version}
	}
	if d.steps < 1 {
		return errors.New("steps must be greater than zero")
	}
	for remaining := d.steps; remaining > 0; remaining-- {
		if version < 0 {
			return errors.New("not enough applied migrations for requested down steps")
		}
		body, _, err := d.source.ReadDown(uint(version))
		if err != nil {
			return fmt.Errorf("read rollback migration %d: %w", version, err)
		}
		if err := body.Close(); err != nil {
			return err
		}
		previous, err := d.source.Prev(uint(version))
		if errors.Is(err, os.ErrNotExist) {
			version = migratedb.NilVersion
		} else if err != nil {
			return err
		} else {
			version = int(previous)
		}
	}
	return nil
}
