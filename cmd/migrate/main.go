// Command migrate applies database migrations owned by auth and history.
package main

import (
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
)

const (
	directionUp      = "up"
	directionDown    = "down"
	directionVersion = "version"
)

var services = []string{"auth", "history"}

func main() {
	if err := godotenv.Load(); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(os.Stderr, "load .env:", err)
		os.Exit(1)
	}

	service := flag.String("service", "all", "service migrations to run: auth, history or all")
	direction := flag.String("direction", directionUp, "migration direction: up, down or version")
	steps := flag.Int("steps", 1, "number of migration steps for direction=down")
	flag.Parse()

	if err := run(*service, *direction, *steps); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(service, direction string, steps int) error {
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
	if config.password == "" {
		return databaseConfig{}, errors.New("POSTGRES_PASSWORD must be set")
	}
	return config, nil
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
	migrationsPath, err := filepath.Abs(filepath.Join("services", service, "migrations"))
	if err != nil {
		return fmt.Errorf("resolve %s migrations path: %w", service, err)
	}

	database, err := sql.Open("postgres", config.url())
	if err != nil {
		return fmt.Errorf("open %s database connection: %w", service, err)
	}
	defer func() {
		resultErr = errors.Join(resultErr, database.Close())
	}()

	driver, err := postgres.WithInstance(database, &postgres.Config{
		MigrationsTable: service + "_schema_migrations",
	})
	if err != nil {
		return fmt.Errorf("create %s migration driver: %w", service, err)
	}

	migration, err := migrate.NewWithDatabaseInstance("file://"+filepath.ToSlash(migrationsPath), service, driver)
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
		version, dirty, versionErr := migration.Version()
		if errors.Is(versionErr, migrate.ErrNilVersion) {
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
