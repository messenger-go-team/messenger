package later

import (
	"context"
	"encoding/json"
	"regexp"
	"time"

	"github.com/messenger-go-team/messenger/services/history/internal/chats"
	"github.com/messenger-go-team/messenger/services/history/internal/reading"
)

// Record is the public active-entry projection, deliberately without owner/state.
// Due/scheduled/unscheduled are derived from one database timestamp per response.
type Record struct {
	ID        string          `json:"id"`
	Message   reading.Message `json:"message"`
	DueAt     *time.Time      `json:"due_at"`
	Status    string          `json:"status"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}
type Result struct {
	ServerTime time.Time `json:"server_time"`
	Entry      Record    `json:"entry"`
}
type List struct {
	ServerTime time.Time `json:"server_time"`
	Entries    []Record  `json:"entries"`
}

// APIRepository returns projections inside the write transaction. A later GET
// after Save could otherwise see a different deadline/state or a deleted source.
type APIRepository interface {
	SaveRecord(context.Context, SaveInput) (Result, bool, error)
	ListRecords(context.Context, string) (List, error)
	Reschedule(context.Context, string, string, *time.Time) (Result, error)
	Complete(context.Context, string, string) error
}
type Service struct{ Repo APIRepository }

func Project(e Entry, source reading.Message, at time.Time) Record {
	status := "unscheduled"
	if e.DueAt != nil {
		status = "scheduled"
		if !e.DueAt.After(at) {
			status = "due"
		}
	}
	return Record{ID: e.ID, Message: source, DueAt: e.DueAt, Status: status, CreatedAt: e.CreatedAt, UpdatedAt: e.UpdatedAt}
}

// The regexp constrains the complete decoded string; Parse performs calendar
// validation. Never trim the supplied date or silently round its microseconds.
var timestamp = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z\z`)

func ParseDue(raw json.RawMessage) (*time.Time, error) {
	var text *string
	if err := json.Unmarshal(raw, &text); err != nil {
		return nil, ErrInvalid
	}
	if text == nil {
		return nil, nil
	}
	if !timestamp.MatchString(*text) {
		return nil, ErrInvalid
	}
	value, err := time.Parse(time.RFC3339Nano, *text)
	if err != nil {
		return nil, ErrInvalid
	}
	return DueTime(&value)
}

func ownerID(raw string) (string, error) {
	id, err := chats.NormalizeID(raw)
	if err != nil {
		return "", chats.ErrIdentity
	}
	return id, nil
}
func (s *Service) Save(ctx context.Context, user, chat, message string, due *time.Time) (Result, bool, error) {
	user, err := ownerID(user)
	if err != nil {
		return Result{}, false, err
	}
	ids, err := NormalizeIDs(chat, message)
	if err != nil {
		return Result{}, false, err
	}
	due, err = DueTime(due)
	if err != nil {
		return Result{}, false, err
	}
	out, created, err := s.Repo.SaveRecord(ctx, SaveInput{UserID: user, ChatID: ids[0], MessageID: ids[1], DueAt: due})
	if err != nil {
		return Result{}, false, err
	}
	return out, created, nil
}
func (s *Service) List(ctx context.Context, user string) (List, error) {
	user, err := ownerID(user)
	if err != nil {
		return List{}, err
	}
	out, err := s.Repo.ListRecords(ctx, user)
	if err != nil {
		return List{}, err
	}
	return out, nil
}
func (s *Service) Reschedule(ctx context.Context, user, id string, due *time.Time) (Result, error) {
	user, err := ownerID(user)
	if err != nil {
		return Result{}, err
	}
	ids, err := NormalizeIDs(id)
	if err != nil {
		return Result{}, err
	}
	due, err = DueTime(due)
	if err != nil {
		return Result{}, err
	}
	out, err := s.Repo.Reschedule(ctx, user, ids[0], due)
	if err != nil {
		return Result{}, err
	}
	return out, nil
}
func (s *Service) Complete(ctx context.Context, user, id string) error {
	user, err := ownerID(user)
	if err != nil {
		return err
	}
	ids, err := NormalizeIDs(id)
	if err != nil {
		return err
	}
	return s.Repo.Complete(ctx, user, ids[0])
}
