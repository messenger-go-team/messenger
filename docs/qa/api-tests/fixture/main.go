// api-fixture only operates on the private Compose databases named below.
// It is not a service route and is never included in production images.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	_ "github.com/lib/pq"
	historyv1 "github.com/messenger-go-team/messenger/api/gen/history/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const password = "T49-fixture-password-only"

var ctx context.Context

func newUUID() string {
	var b [16]byte
	_, err := rand.Read(b[:])
	must(err)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
func db(name string) *sql.DB {
	value := os.Getenv(strings.ToUpper(name) + "_DATABASE_URL")
	u, err := url.Parse(value)
	must(err)
	if u.Hostname() != "postgres" || u.Path != "/api_"+name {
		panic("fixture DSN must name private postgres/api_" + name)
	}
	d, err := sql.Open("postgres", value)
	must(err)
	return d
}
func exec(d *sql.DB, query string, args ...any) {
	_, err := d.ExecContext(ctx, query, args...)
	must(err)
}
func fixturePath() string { return filepath.Join(os.Getenv("API_REPORT_DIR"), "fixture.json") }
func load() map[string]any {
	b, err := os.ReadFile(fixturePath())
	must(err)
	var f map[string]any
	must(json.Unmarshal(b, &f))
	return f
}
func certs() {
	must(os.MkdirAll("/certs", 0755))
	must(os.MkdirAll("/reports", 0777))
	must(os.Chmod("/reports", 0777))
	// The host runner creates public/ before Compose. Its default 0755 mode
	// must allow the unprivileged test UID to write reports on Linux too.
	must(os.MkdirAll("/reports/public", 0777))
	must(os.Chmod("/reports/public", 0777))
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	must(err)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "T49 ephemeral test CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	must(err)
	must(os.WriteFile("/certs/ca.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0644))
	server, err := rsa.GenerateKey(rand.Reader, 2048)
	must(err)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "gateway"}, DNSNames: []string{"gateway"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment}
	signed, err := x509.CreateCertificate(rand.Reader, leaf, ca, &server.PublicKey, key)
	must(err)
	must(os.WriteFile("/certs/server.pem", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: signed}), 0644))
	must(os.WriteFile("/certs/server.key", pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(server)}), 0600))
}
func grants() {
	a := db("auth")
	defer func() { _ = a.Close() }()
	exec(a, `GRANT USAGE ON SCHEMA auth TO api_auth_runtime; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA auth TO api_auth_runtime; GRANT UPDATE ON auth.refresh_tokens TO api_auth_runtime; GRANT DELETE ON auth.contacts TO api_auth_runtime`)
	h := db("history")
	defer func() { _ = h.Close() }()
	exec(h, `GRANT USAGE ON SCHEMA history TO api_history_runtime; GRANT SELECT,INSERT ON history.chats,history.chat_members,history.personal_chat_pairs,history.messages,history.later_entries TO api_history_runtime; GRANT UPDATE(last_seq) ON history.chats TO api_history_runtime; GRANT UPDATE(last_read_seq,last_delivered_seq,public_last_read_seq,public_last_delivered_seq) ON history.chat_members TO api_history_runtime; GRANT UPDATE(id) ON history.messages TO api_history_runtime; GRANT UPDATE(due_at,state,updated_at) ON history.later_entries TO api_history_runtime`)
	certs()
}
func bootstrap() {
	ca, err := os.ReadFile("/certs/ca.pem")
	must(err)
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		panic("bad test CA")
	}
	client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	request := func(method, path, token string, body any, status int) map[string]any {
		raw, err := json.Marshal(body)
		must(err)
		req, err := http.NewRequestWithContext(ctx, method, "https://gateway:8443"+path, bytes.NewReader(raw))
		must(err)
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := client.Do(req)
		must(err)
		defer func() { _ = res.Body.Close() }()
		if res.StatusCode != status {
			panic(fmt.Sprintf("bootstrap %s: HTTP %d", path, res.StatusCode))
		}
		var out map[string]any
		must(json.NewDecoder(res.Body).Decode(&out))
		return out
	}
	f := map[string]any{"baseUrl": "https://gateway:8443", "internalUrl": "http://auth:8080", "password": password, "missingID": newUUID()}
	for _, p := range []struct{ k, u string }{{"a", "qa49_A"}, {"b", "qa49_B"}, {"c", "qa49_C"}} {
		user := request("POST", "/auth/register", "", map[string]string{"username": p.u, "password": password}, 201)
		session := request("POST", "/auth/login", "", map[string]string{"username": p.u, "password": password}, 200)
		f[p.k+"ID"], f[p.k+"Name"], f[p.k+"Token"] = user["id"], p.u, session["access_token"]
	}
	for _, name := range []string{"Alice_1", "Malice_1", strings.Repeat("q", 32)} {
		u := request("POST", "/auth/register", "", map[string]string{"username": name, "password": password}, 201)
		if name == "Alice_1" {
			f["aliceID"] = u["id"]
		}
		if name == "Malice_1" {
			f["maliceID"] = u["id"]
		}
	}
	for i := 1; i <= 21; i++ {
		request("POST", "/auth/register", "", map[string]string{"username": fmt.Sprintf("qa49_search_%02d", i), "password": password}, 201)
	}
	for _, p := range []struct{ key, peer string }{{"chatAB", "bID"}, {"chatAC", "cID"}} {
		chat := request("POST", "/chats/personal", f["aToken"].(string), map[string]any{"user_id": f[p.peer]}, 201)
		f[p.key] = chat["id"]
	}
	conn, err := grpc.NewClient("history:9090", grpc.WithTransportCredentials(insecure.NewCredentials()))
	must(err)
	defer func() { _ = conn.Close() }()
	rpc := historyv1.NewHistoryServiceClient(conn)
	for i := 1; i <= 205; i++ {
		sender := f["bID"].(string)
		if i == 3 {
			sender = f["aID"].(string)
		}
		m, err := rpc.SaveMessage(ctx, &historyv1.SaveMessageRequest{ChatId: f["chatAB"].(string), SenderId: sender, ClientMsgId: newUUID(), Body: fmt.Sprintf("T49 message %03d", i)})
		must(err)
		if m.Seq != int64(i) {
			panic("bad seed seq")
		}
		for _, p := range []struct {
			n   int
			key string
		}{{1, "firstID"}, {3, "ownID"}, {150, "targetID"}, {205, "lastID"}} {
			if p.n == i {
				f[p.key] = m.MessageId
			}
		}
	}
	for i := 0; i < 2; i++ {
		m, err := rpc.SaveMessage(ctx, &historyv1.SaveMessageRequest{ChatId: f["chatAC"].(string), SenderId: f["cID"].(string), ClientMsgId: newUUID(), Body: "T49 access source"})
		must(err)
		f["accessTargetID"] = m.MessageId
	}
	expired, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"sub": f["aID"], "iat": time.Now().Add(-time.Hour).Unix(), "exp": time.Now().Add(-time.Second).Unix()}).SignedString([]byte("t49-jwt-test-only-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
	must(err)
	f["expiredToken"] = expired
	out, err := json.MarshalIndent(f, "", "  ")
	must(err)
	must(os.WriteFile(fixturePath(), out, 0600))
}
func control(mode string) {
	f := map[string]any{}
	if mode != "reset" {
		f = load()
	}
	h := db("history")
	defer func() { _ = h.Close() }()
	switch mode {
	case "reset":
		a := db("auth")
		defer func() { _ = a.Close() }()
		exec(a, `TRUNCATE auth.contacts,auth.refresh_tokens,auth.users CASCADE`)
		exec(h, `TRUNCATE history.later_entries,history.messages,history.personal_chat_pairs,history.chat_members,history.chats CASCADE`)
	case "advance-receipts":
		conn, err := grpc.NewClient("history:9090", grpc.WithTransportCredentials(insecure.NewCredentials()))
		must(err)
		defer func() { _ = conn.Close() }()
		rpc := historyv1.NewHistoryServiceClient(conn)
		for _, step := range []struct {
			actor string
			kind  historyv1.ReceiptKind
			seq   int64
		}{
			{"aID", historyv1.ReceiptKind_RECEIPT_KIND_READ, 42},
			{"aID", historyv1.ReceiptKind_RECEIPT_KIND_DELIVERED, 80},
			{"bID", historyv1.ReceiptKind_RECEIPT_KIND_READ, 3},
			{"bID", historyv1.ReceiptKind_RECEIPT_KIND_DELIVERED, 7},
		} {
			_, err := rpc.AdvanceReceipt(ctx, &historyv1.AdvanceReceiptRequest{ChatId: f["chatAB"].(string), ActorId: f[step.actor].(string), Kind: step.kind, Seq: &step.seq})
			must(err)
		}
	case "append-private-read-message":
		conn, err := grpc.NewClient("history:9090", grpc.WithTransportCredentials(insecure.NewCredentials()))
		must(err)
		defer func() { _ = conn.Close() }()
		rpc := historyv1.NewHistoryServiceClient(conn)
		saved, err := rpc.SaveMessage(ctx, &historyv1.SaveMessageRequest{
			ChatId:      f["chatAB"].(string),
			SenderId:    f["aID"].(string),
			ClientMsgId: newUUID(),
			Body:        "T137 incoming after public receipts",
		})
		must(err)
		if saved.GetSeq() != 206 || saved.GetDuplicate() {
			panic("expected one new message at seq 206")
		}
	case "receipts-group":
		exec(h, `UPDATE history.chats SET type='group' WHERE id=$1`, f["chatAB"])
	case "receipts-personal":
		exec(h, `UPDATE history.chats SET type='personal' WHERE id=$1`, f["chatAB"])
	case "snapshot-later":
		var snapshot []byte
		must(h.QueryRowContext(ctx, `SELECT COALESCE(json_agg(row_to_json(x) ORDER BY x.id),'[]'::json) FROM (SELECT id,user_id,message_id,due_at,state,created_at,updated_at FROM history.later_entries) x`).Scan(&snapshot))
		fmt.Println(string(snapshot))
	case "revoke":
		exec(h, `DELETE FROM history.chat_members WHERE chat_id=$1 AND user_id=$2`, f["chatAC"], f["aID"])
	case "restore":
		exec(h, `INSERT INTO history.chat_members(chat_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`, f["chatAC"], f["aID"])
	case "delete-source":
		exec(h, `DELETE FROM history.messages WHERE id=$1`, f["targetID"])
	case "delete-chat":
		exec(h, `DELETE FROM history.chats WHERE id=$1`, f["chatAC"])
	case "storage-down":
		exec(h, `ALTER TABLE history.later_entries RENAME TO t49_unavailable_later; ALTER TABLE history.chats RENAME TO t49_unavailable_chats; ALTER TABLE history.messages RENAME TO t49_unavailable_messages`)
	case "storage-up":
		exec(h, `ALTER TABLE history.t49_unavailable_messages RENAME TO messages; ALTER TABLE history.t49_unavailable_chats RENAME TO chats; ALTER TABLE history.t49_unavailable_later RENAME TO later_entries`)
	default:
		panic("unknown fixed fixture operation")
	}
}
func main() {
	var cancel context.CancelFunc
	ctx, cancel = context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	defer func() {
		if recover() != nil {
			fmt.Fprintln(os.Stderr, "API fixture operation failed (credentials suppressed)")
			os.Exit(1)
		}
	}()
	if len(os.Args) != 2 {
		panic(errors.New("fixture mode required"))
	}
	switch os.Args[1] {
	case "grants":
		grants()
	case "bootstrap":
		bootstrap()
	default:
		control(os.Args[1])
	}
}
