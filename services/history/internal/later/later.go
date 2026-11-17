// Package later defines rules, storage types and public projections for private
// saved-message entries. The HTTP adapter supplies the verified owner identity.
package later

import (
	"context"
	"errors"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
)

var (
	ErrInvalid = errors.New("invalid later entry")
	// Missing, foreign, done (where active is required), and inaccessible sources
	// share one error; callers must not disclose which check failed.
	ErrNotFound = errors.New("later entry unavailable")
)

type Entry struct {
	ID, UserID, MessageID, State string
	DueAt                        *time.Time
	CreatedAt, UpdatedAt         time.Time
}
type SaveInput struct {
	UserID, ChatID, MessageID string
	DueAt                     *time.Time
}
type Repository interface {
	Save(context.Context, SaveInput) (Entry, bool, error)
	Complete(context.Context, string, string) error
}

// NormalizeIDs follows the existing REST UUID convention without inferring rights.
func NormalizeIDs(ids ...string) ([]string, error) {
	result := make([]string, len(ids))
	for i, id := range ids {
		normalized, err := chats.NormalizeID(id)
		if err != nil {
			return nil, ErrInvalid
		}
		result[i] = normalized
	}
	return result, nil
}

// DueTime validates the typed storage boundary. The raw HTTP string must still
// be checked in #87 before it becomes a time.Time; normalization cannot do that.
func DueTime(value *time.Time) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	utc := value.UTC()
	if utc.Year() < 1 || utc.Year() > 9999 || utc.Nanosecond()%1000 != 0 {
		return nil, ErrInvalid
	}
	return &utc, nil
}
