package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHistoryQueryValidation(t *testing.T) {
	for _, raw := range []string{"limit=0", "limit=101", "limit=999999999999999999999999", "limit=1.5", "limit=1e1", "limit=+1", "limit=1&limit=2", "limit=", "before_seq=0", "before_seq=-1", "after_seq=-1", "after_seq=9007199254740992", "before_seq=1&after_seq=0", "before_seq=", "after_seq=0&after_seq=1", "after_seq=%zz", "limit=10;after_seq=1"} {
		if _, err := readPageQuery(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for _, raw := range []string{"", "limit=1", "limit=100", "before_seq=9007199254740991", "after_seq=0", "after_seq=9007199254740991"} {
		if _, err := readPageQuery(raw); err != nil {
			t.Errorf("rejected %q: %v", raw, err)
		}
	}
}

func TestReadBodyBoundary(t *testing.T) {
	for _, tc := range []struct {
		body, contentType string
		valid             bool
		want              int64
	}{
		{`{"seq":0}`, "application/json", true, 0},
		{`{"seq":9007199254740991}`, "application/json; charset=utf-8", true, 9007199254740991},
		{`{"seq":1}`, "text/plain", false, 0},
		{`{"seq":1}`, "", false, 0},
		{`{"seq": null}`, "application/json", false, 0},
		{`{"seq":true}`, "application/json", false, 0},
		{`{"seq":1,"Seq":2}`, "application/json", false, 0},
		{`{"seq":1,"seq":2}`, "application/json", false, 0},
		{`{"seq":900719925474099199999}`, "application/json", false, 0},
		{`{"seq":1}` + strings.Repeat(" ", 1<<20), "application/json", false, 0},
	} {
		r := httptest.NewRequest("POST", "/chats/id/read", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.contentType)
		var seq int64
		err := readChatField(httptest.NewRecorder(), r, "seq", &seq)
		if (err == nil) != tc.valid || (tc.valid && seq != tc.want) {
			t.Fatal(tc.contentType, seq, err)
		}
	}
}
