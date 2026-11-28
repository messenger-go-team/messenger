package main

import (
	"io"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type frame struct {
	kind int
	data []byte
}

func (f *faults) registerViewer(user string) (<-chan frame, func()) {
	if user == "" {
		return nil, func() {}
	}
	queue := make(chan frame, 1)
	f.mu.Lock()
	if f.viewers == nil {
		f.viewers = make(map[string]map[chan frame]struct{})
	}
	if f.viewers[user] == nil {
		f.viewers[user] = make(map[chan frame]struct{})
	}
	f.viewers[user][queue] = struct{}{}
	f.mu.Unlock()
	return queue, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		delete(f.viewers[user], queue)
		if len(f.viewers[user]) == 0 {
			delete(f.viewers, user)
		}
	}
}

func (f *faults) replayNew(w http.ResponseWriter, req *http.Request) {
	user := req.URL.Query().Get("user")
	data, err := io.ReadAll(http.MaxBytesReader(w, req.Body, 32768))
	event := parseMessageEvent(data)
	if err != nil || !uuid.MatchString(user) || event.Type != "message.new" ||
		!uuid.MatchString(event.Payload.Chat) || !uuid.MatchString(event.Payload.Client) {
		http.Error(w, "expected a viewer and a stored message.new", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.viewers[user]) != 1 {
		http.Error(w, "open exactly one proxied socket for the viewer", http.StatusConflict)
		return
	}
	for queue := range f.viewers[user] {
		select {
		case queue <- frame{kind: websocket.TextMessage, data: data}:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "viewer already has a replay queued", http.StatusConflict)
		}
	}
}

func writeFrame(to *websocket.Conn, msg frame) error {
	if err := to.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	return to.WriteMessage(msg.kind, msg.data)
}

// Keep the reader running while one frame is held so subsequent frames and
// WebSocket control traffic can still reach the viewer.
func (f *faults) relayToViewer(to, from *websocket.Conn, user string, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	stopped := make(chan struct{})
	defer close(stopped)
	incoming := make(chan frame)
	injected, unregister := f.registerViewer(user)
	defer unregister()
	go func() {
		defer close(incoming)
		for {
			kind, data, err := from.ReadMessage()
			if err != nil {
				return
			}
			select {
			case incoming <- frame{kind: kind, data: data}:
			case <-stopped:
				return
			}
		}
	}()

	var held frame
	var release <-chan struct{}
	var timer *time.Timer
	var expires <-chan time.Time
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		select {
		case <-release:
			if err := writeFrame(to, held); err != nil {
				return
			}
			timer.Stop()
			held, release, expires = frame{}, nil, nil
		case <-expires:
			if err := writeFrame(to, held); err != nil {
				return
			}
			held, release, expires = frame{}, nil, nil
		case msg := <-injected:
			if err := writeFrame(to, msg); err != nil {
				return
			}
		case msg, ok := <-incoming:
			if !ok {
				return
			}
			var event messageEvent
			if msg.kind == websocket.TextMessage {
				event = parseMessageEvent(msg.data)
			}
			if f.dropFrame(user, event) {
				continue
			}
			if release == nil {
				var hold string
				switch event.Type {
				case "message.ack":
					hold = "hold-ack"
				case "message.new":
					hold = "hold-new"
				}
				if hold != "" {
					until, ch, matched := f.match(hold, event.Payload.Chat, user, event.Payload.Client, true)
					if matched {
						held, release = msg, ch
						timer = time.NewTimer(time.Until(until))
						expires = timer.C
						continue
					}
				}
			}
			if err := writeFrame(to, msg); err != nil {
				return
			}
			if event.Type == "message.new" {
				if _, _, repeat := f.match("repeat-new", event.Payload.Chat, user, event.Payload.Client, true); repeat {
					if err := writeFrame(to, msg); err != nil {
						return
					}
				}
			}
		}
	}
}
