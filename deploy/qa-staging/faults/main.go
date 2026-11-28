// Command qa-faults is built only into the isolated QA Compose stack.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var readPath = regexp.MustCompile(`^/chats/([^/]+)/read$`)
var messagesPath = regexp.MustCompile(`^/chats/([^/]+)/messages$`)
var errLostResponse = errors.New("QA dropped a response after History returned 204")

type rule struct {
	Kind    string    `json:"kind"`
	Chat    string    `json:"chat,omitempty"`
	User    string    `json:"user,omitempty"`
	Client  string    `json:"client_msg_id,omitempty"`
	Until   time.Time `json:"until"`
	Matches int       `json:"matches"`
	Limit   int       `json:"limit,omitempty"`
	stop    chan struct{}
}

type faults struct {
	mu      sync.Mutex
	rules   map[string]*rule
	viewers map[string]map[chan frame]struct{}
}

func expectedRule(q url.Values) (*rule, error) {
	r := &rule{Kind: q.Get("kind"), Chat: q.Get("chat"), User: q.Get("user"), Client: q.Get("client"), stop: make(chan struct{})}
	for _, id := range []string{r.Chat, r.User, r.Client} {
		if id != "" && !uuid.MatchString(id) {
			return nil, errors.New("expected lowercase UUID")
		}
	}
	seconds, err := strconv.Atoi(q.Get("seconds"))
	if err != nil || seconds < 1 || seconds > 180 {
		return nil, errors.New("seconds must be 1–180")
	}
	r.Until = time.Now().Add(time.Duration(seconds) * time.Second)
	switch r.Kind {
	case "drop-ack", "drop-new", "drop-both":
		if r.Chat == "" || r.User == "" {
			return nil, errors.New("WS rule needs a chat and a viewer")
		}
	case "hold-ack", "hold-new", "repeat-new":
		if r.Chat == "" || r.User == "" {
			return nil, errors.New("WS rule needs a chat and a viewer")
		}
		r.Limit = 1
	case "fail-later":
		if r.User == "" || r.Chat != "" || r.Client != "" {
			return nil, errors.New("Later rule needs only a viewer")
		}
		r.Limit, err = strconv.Atoi(q.Get("count"))
		if err != nil || r.Limit < 1 || r.Limit > 10 {
			return nil, errors.New("count must be 1–10")
		}
	case "no-pong", "slow-reader":
		if r.User == "" || r.Chat != "" || r.Client != "" {
			return nil, errors.New("rule needs only a viewer")
		}
	case "block-history", "hold-read", "drop-read", "skip-extra-read":
		if r.Chat == "" || r.User == "" || r.Client != "" {
			return nil, errors.New("HTTP rule needs a chat and a viewer")
		}
	default:
		return nil, errors.New("unknown QA rule")
	}
	return r, nil
}

func (f *faults) control() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /arm", func(w http.ResponseWriter, req *http.Request) {
		r, err := expectedRule(req.URL.Query())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if old := f.rules[r.Kind]; old != nil {
			close(old.stop)
		}
		f.rules[r.Kind] = r
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /release", func(w http.ResponseWriter, req *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for kind, r := range f.rules {
			if req.URL.Query().Get("kind") == kind || req.URL.Query().Get("kind") == "all" {
				close(r.stop)
				// Retain match counts for the QA report.
				r.stop = make(chan struct{})
				r.Until = time.Now()
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /replay-new", f.replayNew)
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, req *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.rules)
	})
	return mux
}

func (f *faults) match(kind, chat, user, client string, once bool) (time.Time, <-chan struct{}, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.rules[kind]
	if r == nil || !time.Now().Before(r.Until) || r.Chat != chat || r.User != user ||
		(r.Client != "" && r.Client != client) || (once && r.Matches > 0) || (r.Limit > 0 && r.Matches >= r.Limit) {
		return time.Time{}, nil, false
	}
	r.Matches++
	return r.Until, r.stop, true
}

// The subject selects a test rule. The backend still validates the original token.
func subject(token string) string {
	claims := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(token, claims); err != nil {
		return ""
	}
	user, _ := claims.GetSubject()
	return user
}

func (f *faults) skipExtraRead(chat, user string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.rules["skip-extra-read"]
	if r == nil || !time.Now().Before(r.Until) || r.Chat != chat || r.User != user {
		return false
	}
	r.Matches++
	return r.Matches > 1
}

func (f *faults) history(target *url.URL) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(res *http.Response) error {
		req := res.Request
		if req.Method == http.MethodGet && req.URL.Path == "/later" && res.StatusCode == http.StatusOK {
			user := subject(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "))
			if _, _, ok := f.match("fail-later", "", user, "", false); ok {
				const body = `{"code":"service_unavailable","message":"QA Later unavailable"}`
				_ = res.Body.Close()
				res.Body = io.NopCloser(strings.NewReader(body))
				res.ContentLength = int64(len(body))
				res.StatusCode = http.StatusServiceUnavailable
				res.Status = "503 Service Unavailable"
				res.Header.Set("Content-Type", "application/json")
				res.Header.Set("Content-Length", strconv.Itoa(len(body)))
				res.Header.Del("Content-Encoding")
				res.Header.Set("Cache-Control", "no-store")
			}
		}
		if req.Method == http.MethodPost && res.StatusCode == http.StatusNoContent {
			if p := readPath.FindStringSubmatch(req.URL.Path); p != nil {
				user := subject(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "))
				if _, _, ok := f.match("drop-read", p[1], user, "", true); ok {
					return errLostResponse
				}
			}
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, err error) {
		if errors.Is(err, errLostResponse) {
			panic(http.ErrAbortHandler)
		}
		http.Error(w, "History upstream unavailable", http.StatusBadGateway)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		user := subject(strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer "))
		if p := readPath.FindStringSubmatch(req.URL.Path); p != nil && req.Method == http.MethodPost {
			if f.skipExtraRead(p[1], user) {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			until, release, held := f.match("hold-read", p[1], user, "", true)
			if held {
				timer := time.NewTimer(time.Until(until))
				defer timer.Stop()
				select {
				case <-release:
				case <-timer.C:
				case <-req.Context().Done():
					return
				}
			}
		}
		if p := messagesPath.FindStringSubmatch(req.URL.Path); p != nil && req.Method == http.MethodGet {
			if _, _, ok := f.match("block-history", p[1], user, "", false); ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(w, `{"code":"service_unavailable","message":"QA history unavailable"}`)
				return
			}
		}
		proxy.ServeHTTP(w, req)
	})
}

type messageEvent struct {
	Type    string `json:"type"`
	Payload struct {
		Chat   string `json:"chat_id"`
		Client string `json:"client_msg_id"`
	} `json:"payload"`
}

func parseMessageEvent(data []byte) messageEvent {
	var event messageEvent
	if json.Unmarshal(data, &event) != nil {
		return messageEvent{}
	}
	return event
}

func (f *faults) dropFrame(user string, event messageEvent) bool {
	var kind string
	switch event.Type {
	case "message.ack":
		kind = "drop-ack"
	case "message.new":
		kind = "drop-new"
	default:
		return false
	}
	_, _, both := f.match("drop-both", event.Payload.Chat, user, event.Payload.Client, false)
	_, _, single := f.match(kind, event.Payload.Chat, user, event.Payload.Client, false)
	return both || single
}

func (f *faults) websocket(w http.ResponseWriter, req *http.Request) {
	protocols := websocket.Subprotocols(req)
	headers := http.Header{"Origin": []string{req.Header.Get("Origin")}}
	dialer := websocket.Dialer{HandshakeTimeout: 8 * time.Second, Subprotocols: protocols}
	back, res, err := dialer.DialContext(req.Context(), "ws://chat:8080/ws", headers)
	if err != nil {
		if res == nil {
			http.Error(w, "Chat upstream unavailable", http.StatusBadGateway)
			return
		}
		defer func() { _ = res.Body.Close() }()
		if contentType := res.Header.Get("Content-Type"); contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		w.WriteHeader(res.StatusCode)
		_, _ = io.Copy(w, io.LimitReader(res.Body, 16*1024))
		return
	}
	defer func() { _ = back.Close() }()

	// Chat has already verified Origin and the offered subprotocols.
	upgrader := websocket.Upgrader{
		CheckOrigin:  func(*http.Request) bool { return true },
		Subprotocols: []string{back.Subprotocol()},
	}
	front, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	defer func() { _ = front.Close() }()
	front.SetReadLimit(1024 * 1024)
	back.SetReadLimit(1024 * 1024)

	user := ""
	for _, value := range protocols {
		if strings.HasPrefix(value, "bearer.") {
			user = subject(strings.TrimPrefix(value, "bearer."))
		}
	}

	until, release, slow := f.match("slow-reader", "", user, "", false)
	if slow {
		if tcp, ok := back.UnderlyingConn().(*net.TCPConn); ok {
			_ = tcp.SetReadBuffer(1024)
		}
	}
	transferControls(front, back, nil)
	transferControls(back, front, func() bool {
		_, _, drop := f.match("no-pong", "", user, "", false)
		return drop
	})

	done := make(chan struct{}, 2)
	go relay(back, front, done)
	go func() {
		if slow {
			timer := time.NewTimer(time.Until(until))
			defer timer.Stop()
			select {
			case <-release:
			case <-timer.C:
			case <-req.Context().Done():
				done <- struct{}{}
				return
			}
		}
		f.relayToViewer(front, back, user, done)
	}()
	<-done
}

func transferControls(from, to *websocket.Conn, skipPing func() bool) {
	send := func(kind int, data []byte) error {
		return to.WriteControl(kind, data, time.Now().Add(2*time.Second))
	}
	from.SetPingHandler(func(data string) error {
		if skipPing != nil && skipPing() {
			return nil
		}
		return send(websocket.PingMessage, []byte(data))
	})
	from.SetPongHandler(func(data string) error { return send(websocket.PongMessage, []byte(data)) })
	from.SetCloseHandler(func(code int, text string) error {
		return send(websocket.CloseMessage, websocket.FormatCloseMessage(code, text))
	})
}

func relay(to, from *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		kind, data, err := from.ReadMessage()
		if err != nil {
			return
		}
		if err := writeFrame(to, frame{kind: kind, data: data}); err != nil {
			return
		}
	}
}

func main() {
	if len(os.Args) > 1 {
		var err error
		switch os.Args[1] {
		case "seed":
			err = seedRun(os.Args[2:])
		case "burst":
			err = burst(os.Args[2:])
		case "auth-check":
			err = checkInternalAuth(os.Args[2:])
		default:
			log.Fatal("unknown QA tool command")
		}
		if err != nil {
			log.Fatal(err)
		}
		return
	}
	f := &faults{rules: make(map[string]*rule)}
	public := http.NewServeMux()
	public.HandleFunc("GET /ws", f.websocket)
	public.Handle("/", f.history(&url.URL{Scheme: "http", Host: "history:8080"}))

	errs := make(chan error, 2)
	for port, handler := range map[int]http.Handler{8080: public, 8081: f.control()} {
		go func() {
			server := http.Server{
				Addr:              fmt.Sprintf(":%d", port),
				Handler:           handler,
				ReadHeaderTimeout: 5 * time.Second,
			}
			errs <- server.ListenAndServe()
		}()
	}
	log.Fatal(<-errs)
}
