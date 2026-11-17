package auth

import "time"

// Only JWT issuance uses this clock. Refresh expiry remains a database-time
// decision inside the repository transaction, never an application-clock check.
type clock interface {
	Now() time.Time
}

type wallClock struct{}

func (wallClock) Now() time.Time { return time.Now() }
