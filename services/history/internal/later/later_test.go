package later

import (
	"errors"
	"testing"
	"time"
)

func TestTypedStorageBoundary(t *testing.T) {
	if value, err := DueTime(nil); value != nil || err != nil {
		t.Fatal(value, err)
	}
	for _, value := range []time.Time{
		time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(9999, 12, 31, 23, 59, 59, 999999000, time.UTC),
		time.Date(2024, 2, 29, 19, 0, 0, 123456000, time.FixedZone("device", 3*3600)),
	} {
		got, err := DueTime(&value)
		if err != nil || !got.Equal(value) || got.Location() != time.UTC {
			t.Fatal(value, got, err)
		}
	}
	for _, value := range []time.Time{
		time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 1, 1, 0, 0, 0, 1, time.UTC),
		time.Date(1, 1, 1, 0, 0, 0, 0, time.FixedZone("east", 3600)),
	} {
		if _, err := DueTime(&value); !errors.Is(err, ErrInvalid) {
			t.Fatal(value, err)
		}
	}
	ids, err := NormalizeIDs("23968CC7-C30C-47B0-A741-6B81249AA5E7")
	if err != nil || ids[0] != "23968cc7-c30c-47b0-a741-6b81249aa5e7" {
		t.Fatal(ids, err)
	}
	if _, err := NormalizeIDs("not-a-uuid"); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}
