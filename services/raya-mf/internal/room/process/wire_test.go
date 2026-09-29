package process

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
)

func packet(body string) []byte {
	buf := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(buf, uint32(len(body)))
	copy(buf[4:], body)
	return buf
}

func TestWireRoundTrip(t *testing.T) {
	id := "client-rvs_test"
	f := &engine.Frame{Turn: "turn", Final: true, Epoch: 3, Seq: 4, Start: 960, End: 1440, Item: "item", PCM: bytes.Repeat([]byte{7}, 960), Rate: 24000, At: time.Date(2026, 9, 28, 0, 0, 0, 123, time.UTC)}
	rows := []Message{
		{Version: 1, Session: id, ID: 1, Op: "join", Expires: 1, Startup: &Startup{URL: "wss://localhost", Token: "private", Name: "room", Client: id, Rate: 24000}},
		{Version: 1, Session: id, ID: 1, Op: "ready", Outcome: "confirmed"},
		{Version: 1, Session: id, ID: 1, Op: "ready", Outcome: "refused", Error: "setup"},
		{Version: 1, Session: id, ID: 2, Op: "publish", Expires: 1, Frame: f},
		{Version: 1, Session: id, Op: "input", Frame: f},
		{Version: 1, Session: id, ID: 3, Op: "send", Expires: 1, Data: &room.Data{Identity: id, Topic: "receipt", Body: bytes.Repeat([]byte{1}, 15360)}},
		{Version: 1, Session: id, Op: "data", Data: &room.Data{Identity: id, Topic: "receipt", Body: []byte("payload")}},
		{Version: 1, Session: id, ID: 4, Op: "flush", Expires: 1, Turn: "turn"},
		{Version: 1, Session: id, ID: 5, Op: "stop", Expires: 1},
		{Version: 1, Session: id, ID: 5, Op: "ack", Outcome: "unknown", Error: "native"},
		{Version: 1, Session: id, Op: "failure", Error: "io"},
	}
	var buf bytes.Buffer
	for _, row := range rows {
		if err := Write(&buf, row); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range rows {
		got, err := Read(&buf)
		if err != nil || !reflect.DeepEqual(got, row) {
			t.Fatalf("round trip %s: %v", row.Op, err)
		}
	}
	if _, err := Read(&buf); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
}

func TestWireStrictJSON(t *testing.T) {
	base := `"version":1,"session":"client-rvs_test","id":1,"op":"ready","outcome":"confirmed"`
	rows := []string{
		`{` + base + `,"extra":true}`, `{` + base + `,"constructor":true}`, `{` + base + `,"__proto__":true}`,
		`{` + base + `,"Version":1}`, `{` + base + `,"version":1}`, `{` + base + `,"frame":null}`,
		`{` + base + `,"turn":""}`, `{` + base + `,"expires":0}`, `{` + base + `} {}`, `{` + base + `} trailing`,
		`{"version":1,"session":"client-rvs_test","op":"failure","error":"io"}`,
		`{"version":1,"session":"client-rvs_test","id":0,"op":"failure","error":"private token"}`,
		`{"version":1,"session":"client-rvs_test\n","id":0,"op":"failure","error":"io"}`,
		`{"version":1,"session":"client-rvs_test","id":1,"op":"ready"}`,
		`{"version":1,"session":"client-rvs_test","id":1,"op":"join","expires":1,"startup":{"url":"x","token":"private","name":"n","client":"client-rvs_test","rate":24000,"Rate":24000}}`,
		`{"version":1,"session":"client-rvs_test","id":0,"op":"data","data":{"topic":"x","body":"eA==","constructor":0}}`,
		`{"version":1,"session":"client-rvs_test","id":0,"op":"data","data":{"topic":"x","topic":"x","body":"eA=="}}`,
		`{"version":1,"session":"client-rvs_test","id":0,"op":"data","data":{"topic":"x","body":[]}}`,
		`{"version":1,"session":"client-rvs_test","id":9007199254740992,"op":"ack","outcome":"confirmed"}`,
	}
	for i, body := range rows {
		if _, err := Read(bytes.NewReader(packet(body))); err == nil {
			t.Fatalf("accepted malformed row %d", i)
		}
	}
	if _, err := Read(bytes.NewReader(packet("{" + base + "}\n\t"))); err != nil {
		t.Fatal(err)
	}
}

func TestWireInvalidDoesNotWrite(t *testing.T) {
	base := Message{Version: 1, Session: "client-rvs_test", ID: 2, Op: "stop", Expires: 1}
	rows := []Message{base, base, base, base, base, base, base, base, base}
	rows[0].Version = 2
	rows[1].Session += "\n"
	rows[2].Expires = 0
	rows[3].ID = 0
	rows[4].Frame = &engine.Frame{}
	rows[5].Outcome = "confirmed"
	rows[6].Error = "private"
	rows[7] = Message{Version: 1, Session: base.Session, ID: 1, Op: "join", Expires: 1, Startup: &Startup{URL: "x", Token: strings.Repeat("\x00", 16384), Client: base.Session, Rate: 24000}}
	rows[8] = Message{Version: 1, Session: base.Session, ID: 2, Op: "send", Expires: 1, Data: &room.Data{Topic: "x", Body: make([]byte, 15361)}}
	for i, row := range rows {
		var buf bytes.Buffer
		if Validate(row) == nil || Write(&buf, row) == nil || buf.Len() != 0 {
			t.Fatalf("invalid row %d wrote bytes", i)
		}
	}
}

func TestWireBoundsAndMixedFields(t *testing.T) {
	id := "client-rvs_test"
	rows := []Message{
		{Version: 1, Session: id, Op: "input", Frame: &engine.Frame{Rate: 16000, PCM: make([]byte, 641)}},
		{Version: 1, Session: id, Op: "input", Frame: &engine.Frame{Rate: 48000, PCM: make([]byte, 1920)}},
		{Version: 1, Session: id, Op: "input", Frame: &engine.Frame{Rate: 24000, PCM: make([]byte, 960), Start: 2, End: 1}},
		{Version: 1, Session: id, Op: "input", Frame: &engine.Frame{Rate: 24000, PCM: make([]byte, 960), Epoch: safe + 1}},
		{Version: 1, Session: id, Op: "input", Frame: &engine.Frame{Rate: 24000, PCM: make([]byte, 960), Item: strings.Repeat("x", 257)}},
		{Version: 1, Session: id, Op: "data", Data: &room.Data{Topic: "x", Body: make([]byte, 4097)}},
		{Version: 1, Session: id, Op: "data", Data: &room.Data{Topic: " x", Body: []byte{1}}},
		{Version: 1, Session: id, Op: "data", Data: &room.Data{Topic: "x", Identity: strings.Repeat("x", 257), Body: []byte{1}}},
		{Version: 1, Session: id, Op: "data", Data: &room.Data{Topic: string([]byte{255}), Body: []byte{1}}},
		{Version: 1, Session: id, ID: 2, Op: "ack", Outcome: "confirmed", Error: "unknown"},
		{Version: 1, Session: id, ID: 1, Op: "ready", Outcome: "refused", Error: "native"},
		{Version: 1, Session: id, ID: 1, Op: "join", Expires: 1, Startup: &Startup{URL: "x", Token: "t", Client: "client-rvs_other", Rate: 24000}},
	}
	for i, row := range rows {
		if Validate(row) == nil {
			t.Fatalf("accepted invalid bounds row %d", i)
		}
	}
	row := Message{Version: 1, Session: id, Op: "input", Frame: &engine.Frame{Rate: 16000, PCM: make([]byte, 640)}}
	var buf bytes.Buffer
	if err := Write(&buf, row); err != nil {
		t.Fatal(err)
	}
	if got, err := Read(&buf); err != nil || got.Frame.Rate != 16000 || len(got.Frame.PCM) != 640 {
		t.Fatal("16k input", err)
	}
}

type prefix struct {
	calls int
	size  uint32
}

func (p *prefix) Read(buf []byte) (int, error) {
	p.calls++
	if p.calls > 1 {
		return 0, errors.New("body must not be read")
	}
	binary.BigEndian.PutUint32(buf, p.size)
	return 4, nil
}
func TestWireRejectsSizeBeforeBody(t *testing.T) {
	for _, size := range []uint32{0, Max + 1, ^uint32(0)} {
		p := &prefix{size: size}
		if _, err := Read(p); err == nil || p.calls != 1 {
			t.Fatal("unbounded body read")
		}
	}
	if _, err := Read(bytes.NewReader([]byte{0, 0})); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(err)
	}
	if _, err := Read(bytes.NewReader(packet(`{}`)[:5])); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatal(err)
	}
}

type partial struct {
	bytes.Buffer
	zero bool
}

func (p *partial) Write(buf []byte) (int, error) {
	if p.zero {
		return 0, nil
	}
	return p.Buffer.Write(buf[:1])
}
func TestWirePartialWrite(t *testing.T) {
	row := Message{Version: 1, Session: "client-rvs_test", ID: 1, Op: "ready", Outcome: "confirmed"}
	p := &partial{}
	if err := Write(p, row); err != nil {
		t.Fatal(err)
	}
	if got, err := Read(&p.Buffer); err != nil || got != row {
		t.Fatal("partial round trip", err)
	}
	if err := Write(&partial{zero: true}, row); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
}
