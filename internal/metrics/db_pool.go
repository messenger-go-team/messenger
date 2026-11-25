package metrics

import (
	"database/sql"

	"github.com/prometheus/client_golang/prometheus"
)

type dbPoolCollector struct {
	db          *sql.DB
	connections *prometheus.Desc
	maxOpen     *prometheus.Desc
	waits       *prometheus.Desc
	waitSeconds *prometheus.Desc
}

// NewDBPoolCollector exposes one local snapshot per scrape without borrowing
// a connection, even when every connection in the pool is in use.
func NewDBPoolCollector(service string, db *sql.DB) prometheus.Collector {
	return &dbPoolCollector{
		db: db,
		connections: prometheus.NewDesc(prometheus.BuildFQName(service, "db_pool", "connections"),
			"Number of SQL pool connections by state.", []string{"state"}, nil),
		maxOpen: prometheus.NewDesc(prometheus.BuildFQName(service, "db_pool", "max_open_connections"),
			"Configured maximum open SQL connections (zero means unlimited).", nil, nil),
		waits: prometheus.NewDesc(prometheus.BuildFQName(service, "db_pool", "waits_total"),
			"Number of waits for an SQL pool connection.", nil, nil),
		waitSeconds: prometheus.NewDesc(prometheus.BuildFQName(service, "db_pool", "wait_duration_seconds_total"),
			"Total time spent waiting for SQL pool connections in seconds.", nil, nil),
	}
}

func (c *dbPoolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.connections
	ch <- c.maxOpen
	ch <- c.waits
	ch <- c.waitSeconds
}

func (c *dbPoolCollector) Collect(ch chan<- prometheus.Metric) {
	stats := c.db.Stats()
	ch <- prometheus.MustNewConstMetric(c.connections, prometheus.GaugeValue, float64(stats.OpenConnections), "open")
	ch <- prometheus.MustNewConstMetric(c.connections, prometheus.GaugeValue, float64(stats.InUse), "in_use")
	ch <- prometheus.MustNewConstMetric(c.connections, prometheus.GaugeValue, float64(stats.Idle), "idle")
	ch <- prometheus.MustNewConstMetric(c.maxOpen, prometheus.GaugeValue, float64(stats.MaxOpenConnections))
	ch <- prometheus.MustNewConstMetric(c.waits, prometheus.CounterValue, float64(stats.WaitCount))
	ch <- prometheus.MustNewConstMetric(c.waitSeconds, prometheus.CounterValue, stats.WaitDuration.Seconds())
}
