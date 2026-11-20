package main

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const wsSendType = "message.send"

var wsUUIDPattern = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
)
var wsUTCTimestampPattern = regexp.MustCompile(
	`^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([Zz]|\+00:00)$`,
)

type wsCommand struct {
	kind        string
	id          string
	chatID      string
	clientMsgID string
	body        string
}

func validWSUUID(value string) bool {
	return value != "00000000-0000-0000-0000-000000000000" && wsUUIDPattern.MatchString(value)
}

func validWSClientID(value string) bool {
	return validWSUUID(value) && value[14] == '4' && strings.ContainsRune("89abAB", rune(value[19]))
}

func decodeWSObject(raw []byte) (fields map[string]json.RawMessage, duplicate bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, false
	}

	fields = make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false
		}
		if _, exists := fields[name]; exists {
			duplicate = true
			// Keep the key present, but leave its value unavailable for correlation.
			fields[name] = nil
			continue
		}
		fields[name] = value
	}

	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return nil, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, false
	}
	return fields, duplicate
}

func wsString(raw json.RawMessage) string {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}

func parseWSCommand(raw []byte) (wsCommand, string) {
	fields, duplicate := decodeWSObject(raw)
	if fields == nil {
		return wsCommand{}, "invalid_json"
	}
	cmd := wsCommand{kind: wsString(fields["type"])}
	if id := wsString(fields["id"]); validWSUUID(id) {
		cmd.id = id
	}
	payload, payloadDuplicate := decodeWSObject(fields["payload"])
	if cmd.kind == wsSendType {
		if id := wsString(payload["client_msg_id"]); validWSClientID(id) {
			cmd.clientMsgID = strings.ToLower(id)
		}
	}
	if duplicate || len(fields) != 4 || cmd.kind == "" || cmd.id == "" ||
		!validWSTime(wsString(fields["ts"])) || payload == nil || payloadDuplicate {
		return cmd, "invalid_payload"
	}
	if cmd.kind != wsSendType {
		return cmd, "unsupported_type"
	}

	cmd.chatID = strings.ToLower(wsString(payload["chat_id"]))
	cmd.body = wsString(payload["body"])
	if len(payload) != 3 || !validWSUUID(cmd.chatID) || cmd.clientMsgID == "" ||
		!validWSBody(cmd.body) || !validWSBodyEscapes(payload["body"]) {
		return cmd, "invalid_payload"
	}
	return cmd, ""
}

func validWSTime(value string) bool {
	if !wsUTCTimestampPattern.MatchString(value) {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, strings.ToUpper(value))
	return err == nil
}

func validWSBody(body string) bool {
	n := utf8.RuneCountInString(body)
	if n == 0 || n > 4096 || strings.IndexByte(body, 0) >= 0 {
		return false
	}
	for _, r := range body {
		if !unicode.IsSpace(r) {
			return true
		}
	}
	return false
}

func validWSBodyEscapes(raw json.RawMessage) bool {
	for i := 1; i < len(raw)-1; i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		code, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		switch {
		case code >= 0xDC00 && code <= 0xDFFF:
			return false
		case code >= 0xD800 && code <= 0xDBFF:
			if i+6 >= len(raw)-1 || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xDC00 || low > 0xDFFF {
				return false
			}
			i += 6
		}
	}
	return true
}
