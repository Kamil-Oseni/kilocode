// raya_change - Strict bounded isolated native media process framing.
package process

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

const Version = 1
const Max = 32768
const safe = uint64(1<<53 - 1)

var invalid = errors.New("invalid isolated media message")
var session = regexp.MustCompile(`^client-rvs_[A-Za-z0-9_-]{1,128}$`)

type Startup struct {
	URL    string `json:"url"`
	Token  string `json:"token"`
	Name   string `json:"name"`
	Client string `json:"client"`
	Rate   int    `json:"rate"`
}

type Message struct {
	Version int
	Session string
	ID      uint64
	Op      string
	Expires int64
	Startup *Startup
	Frame   *engine.Frame
	Data    *room.Data
	Turn    string
	Outcome string
	Error   string
}

type frame struct {
	Turn  string    `json:"turn,omitempty"`
	Final bool      `json:"final,omitempty"`
	Epoch uint64    `json:"epoch,omitempty"`
	Seq   uint64    `json:"seq,omitempty"`
	Start uint64    `json:"start,omitempty"`
	End   uint64    `json:"end,omitempty"`
	Item  string    `json:"item,omitempty"`
	PCM   []byte    `json:"pcm"`
	Rate  int       `json:"rate"`
	At    time.Time `json:"at"`
}
type data struct {
	Identity string `json:"identity,omitempty"`
	Topic    string `json:"topic"`
	Body     []byte `json:"body"`
}
type wire struct {
	Version int      `json:"version"`
	Session string   `json:"session"`
	ID      uint64   `json:"id"`
	Op      string   `json:"op"`
	Expires int64    `json:"expires,omitempty"`
	Startup *Startup `json:"startup,omitempty"`
	Frame   *frame   `json:"frame,omitempty"`
	Data    *data    `json:"data,omitempty"`
	Turn    string   `json:"turn,omitempty"`
	Outcome string   `json:"outcome,omitempty"`
	Error   string   `json:"error,omitempty"`
}

func bounded(value string, maximum int) bool { return len(value) <= maximum && utf8.ValidString(value) }
func code(value string) bool {
	switch value {
	case "", "invalid", "expired", "stopped", "busy", "unknown", "native", "io", "setup", "closed":
		return true
	}
	return false
}

// Validate refuses mixed commands and invalid fields before any pipe write.
// Expiry is a bounded absolute millisecond value; the owned worker checks time.
func Validate(m Message) error {
	if m.Version != Version || !session.MatchString(m.Session) || !bounded(m.Session, 256) || m.ID > safe || m.Expires < 0 || uint64(m.Expires) > safe || !bounded(m.Turn, 256) || !code(m.Error) {
		return invalid
	}
	request := m.Op == "join" || m.Op == "publish" || m.Op == "send" || m.Op == "flush" || m.Op == "stop"
	if request {
		if m.ID == 0 || m.Expires == 0 || m.Outcome != "" || m.Error != "" {
			return invalid
		}
	} else if m.Expires != 0 {
		return invalid
	}
	if m.Op != "join" && m.Startup != nil || m.Op != "publish" && m.Op != "input" && m.Frame != nil || m.Op != "send" && m.Op != "data" && m.Data != nil || m.Op != "flush" && m.Turn != "" {
		return invalid
	}
	if m.Op != "ack" && m.Op != "ready" && m.Outcome != "" || m.Op != "ack" && m.Op != "ready" && m.Op != "failure" && m.Error != "" {
		return invalid
	}
	switch m.Op {
	case "join":
		v := m.Startup
		if m.ID != 1 || v == nil || v.Client != m.Session || v.URL == "" || !bounded(v.URL, 2048) || v.Token == "" || !bounded(v.Token, 16384) || !bounded(v.Name, 256) || v.Rate != 16000 && v.Rate != 24000 {
			return invalid
		}
	case "ready":
		if m.ID != 1 || !(m.Outcome == "confirmed" && m.Error == "" || m.Outcome == "refused" && m.Error == "setup") {
			return invalid
		}
	case "ack":
		if m.ID == 0 || m.Outcome != "confirmed" && m.Outcome != "refused" && m.Outcome != "unknown" || m.Outcome == "confirmed" && m.Error != "" {
			return invalid
		}
	case "input", "publish":
		f := m.Frame
		if f == nil || !bounded(f.Turn, 256) || !bounded(f.Item, 256) || f.Epoch > safe || f.Seq > safe || f.Start > safe || f.End > safe || f.End < f.Start {
			return invalid
		}
		if m.Op == "publish" {
			if f.Rate != 24000 || len(f.PCM) != 960 {
				return invalid
			}
		} else if m.ID != 0 || f.Rate != 16000 && f.Rate != 24000 || len(f.PCM) != f.Rate/50*2 {
			return invalid
		}
	case "send", "data":
		d := m.Data
		maximum := 15360
		if m.Op == "data" {
			maximum = 4096
			if m.ID != 0 {
				return invalid
			}
		}
		if d == nil || len(d.Body) == 0 || len(d.Body) > maximum || d.Topic == "" || strings.TrimSpace(d.Topic) != d.Topic || !bounded(d.Topic, 128) || !bounded(d.Identity, 256) {
			return invalid
		}
	case "flush", "stop":
	case "failure":
		if m.ID != 0 || m.Error == "" {
			return invalid
		}
	default:
		return invalid
	}
	body, err := json.Marshal(pack(m))
	if err != nil || len(body) > Max {
		return invalid
	}
	return nil
}

func pack(m Message) wire {
	v := wire{Version: m.Version, Session: m.Session, ID: m.ID, Op: m.Op, Expires: m.Expires, Startup: m.Startup, Turn: m.Turn, Outcome: m.Outcome, Error: m.Error}
	if f := m.Frame; f != nil {
		v.Frame = &frame{Turn: f.Turn, Final: f.Final, Epoch: f.Epoch, Seq: f.Seq, Start: f.Start, End: f.End, Item: f.Item, PCM: f.PCM, Rate: f.Rate, At: f.At}
	}
	if d := m.Data; d != nil {
		v.Data = &data{Identity: d.Identity, Topic: d.Topic, Body: d.Body}
	}
	return v
}
func unpack(v wire) Message {
	m := Message{Version: v.Version, Session: v.Session, ID: v.ID, Op: v.Op, Expires: v.Expires, Startup: v.Startup, Turn: v.Turn, Outcome: v.Outcome, Error: v.Error}
	if f := v.Frame; f != nil {
		m.Frame = &engine.Frame{Turn: f.Turn, Final: f.Final, Epoch: f.Epoch, Seq: f.Seq, Start: f.Start, End: f.End, Item: f.Item, PCM: f.PCM, Rate: f.Rate, At: f.At}
	}
	if d := v.Data; d != nil {
		m.Data = &room.Data{Identity: d.Identity, Topic: d.Topic, Body: d.Body}
	}
	return m
}

// Check exact key spelling, duplicate keys, nulls and nested unknown fields.
func object(d *json.Decoder, path string) error {
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return invalid
	}
	allowed := map[string]bool{}
	switch path {
	case "":
		for _, k := range []string{"version", "session", "id", "op", "expires", "startup", "frame", "data", "turn", "outcome", "error"} {
			allowed[k] = true
		}
	case "startup":
		for _, k := range []string{"url", "token", "name", "client", "rate"} {
			allowed[k] = true
		}
	case "frame":
		for _, k := range []string{"turn", "final", "epoch", "seq", "start", "end", "item", "pcm", "rate", "at"} {
			allowed[k] = true
		}
	case "data":
		for _, k := range []string{"identity", "topic", "body"} {
			allowed[k] = true
		}
	default:
		return invalid
	}
	seen := map[string]bool{}
	for d.More() {
		key, err := d.Token()
		if err != nil {
			return invalid
		}
		k, ok := key.(string)
		if !ok || !allowed[k] || seen[k] {
			return invalid
		}
		seen[k] = true
		if path == "" && (k == "startup" || k == "frame" || k == "data") {
			if err := object(d, k); err != nil {
				return err
			}
			continue
		}
		v, err := d.Token()
		if err != nil || v == nil {
			return invalid
		}
		if _, ok := v.(json.Delim); ok {
			return invalid
		}
	}
	end, err := d.Token()
	if err != nil || end != json.Delim('}') {
		return invalid
	}
	if path == "" {
		for _, k := range []string{"version", "session", "id", "op"} {
			if !seen[k] {
				return invalid
			}
		}
	}
	return nil
}

func Read(reader io.Reader) (Message, error) {
	var prefix [4]byte
	if _, err := io.ReadFull(reader, prefix[:]); err != nil {
		return Message{}, err
	}
	size := binary.BigEndian.Uint32(prefix[:])
	if size == 0 || size > Max {
		return Message{}, invalid
	}
	body := make([]byte, int(size))
	if _, err := io.ReadFull(reader, body); err != nil {
		return Message{}, err
	}
	if !utf8.Valid(body) {
		return Message{}, invalid
	}
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	if err := object(d, ""); err != nil {
		return Message{}, invalid
	}
	if _, err := d.Token(); err != io.EOF {
		return Message{}, invalid
	}
	var v wire
	d = json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if err := d.Decode(&v); err != nil {
		return Message{}, invalid
	}
	m := unpack(v)
	if err := Validate(m); err != nil {
		return Message{}, err
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(body, &keys); err != nil {
		return Message{}, invalid
	}
	for _, k := range []string{"startup", "frame", "data", "turn", "outcome", "error", "expires"} {
		if _, ok := keys[k]; !ok {
			continue
		}
		allowed := k == "startup" && m.Op == "join" || k == "frame" && (m.Op == "publish" || m.Op == "input") || k == "data" && (m.Op == "send" || m.Op == "data") || k == "turn" && m.Op == "flush" || k == "outcome" && (m.Op == "ack" || m.Op == "ready") || k == "error" && (m.Op == "ack" || m.Op == "ready" || m.Op == "failure") || k == "expires" && (m.Op == "join" || m.Op == "publish" || m.Op == "send" || m.Op == "flush" || m.Op == "stop")
		if !allowed {
			return Message{}, invalid
		}
	}
	return m, nil
}

func Write(writer io.Writer, m Message) error {
	if err := Validate(m); err != nil {
		return err
	}
	body, err := json.Marshal(pack(m))
	if err != nil || len(body) > Max {
		return invalid
	}
	var prefix [4]byte
	binary.BigEndian.PutUint32(prefix[:], uint32(len(body)))
	for _, data := range [][]byte{prefix[:], body} {
		for len(data) > 0 {
			n, err := writer.Write(data)
			if err != nil {
				return err
			}
			if n <= 0 || n > len(data) {
				return io.ErrShortWrite
			}
			data = data[n:]
		}
	}
	return nil
}
