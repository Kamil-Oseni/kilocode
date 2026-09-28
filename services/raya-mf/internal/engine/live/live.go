// raya_change - GPT-Live1 primary WebSocket engine, not the Realtime protocol.
package live

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/media"
	"github.com/coder/websocket"
)

const endpoint = "wss://api.openai.com/v1/live/sessions"
const startup = 5 * time.Second
const closing = time.Second
const reserve = closing + 300*time.Millisecond

var errFinal = errors.New("GPT-Live final session usage is unconfirmed")

type Engine struct{}

func (Engine) Descriptor() engine.Descriptor {
	return engine.Descriptor{ID: "openai-live", AcceptsTruncation: false, NativeBargeIn: true, NativeEndpointing: true, RequiresContinuousInput: true, InputRate: 24000, OutputRate: 24000}
}

func (Engine) Open(ctx context.Context, cfg engine.Config) (engine.Session, error) {
	if cfg.Key == "" || len(cfg.Key) > 1024 || strings.ContainsAny(cfg.Key, "\r\n") {
		return nil, errors.New("a trusted server OpenAI project key is required")
	}
	if cfg.Model == "" {
		cfg.Model = "gpt-live-1"
	}
	if cfg.Model != "gpt-live-1" || (cfg.Mode != "" && cfg.Mode != "hands-free") {
		return nil, errors.New("this engine requires continuous GPT-Live1 audio")
	}
	if cfg.Delegation != "" && cfg.Delegation != "client" {
		return nil, errors.New("GPT-Live supports only explicit client delegation")
	}
	if math.IsNaN(cfg.MaximumSeconds) || math.IsInf(cfg.MaximumSeconds, 0) || cfg.MaximumSeconds < 0 || cfg.MaximumSeconds > 86400 || cfg.MaximumSeconds > 0 && cfg.MaximumSeconds <= reserve.Seconds()+0.1 || cfg.Delegation == "client" && cfg.MaximumSeconds == 0 {
		return nil, errors.New("GPT-Live client delegation requires a finite reserved lifetime greater than 1.4 seconds and at most 86400 seconds")
	}
	if cfg.Voice == "" {
		cfg.Voice = "marin"
	}
	if !identifier(cfg.Voice) || !utf8.ValidString(cfg.Instructions) || len(cfg.Instructions) > 32768 {
		return nil, errors.New("invalid GPT-Live startup configuration")
	}
	raw := cfg.Endpoint
	if raw == "" {
		raw = endpoint
	}
	uri, err := url.Parse(raw)
	if err != nil || !address(uri) {
		return nil, errors.New("GPT-Live requires its primary session endpoint without query parameters")
	}
	id, err := random()
	if err != nil {
		return nil, err
	}
	// Start the wall budget before Dial. Fence capture early enough to leave a
	// bounded finalization allowance; final usage still requires its exact ACK.
	budget, release := context.WithCancel(ctx)
	if cfg.MaximumSeconds > 0 {
		release()
		budget, release = context.WithTimeout(ctx, time.Duration(cfg.MaximumSeconds*float64(time.Second))-reserve)
	}
	ctx = budget
	owned := false
	defer func() {
		if !owned {
			release()
		}
	}()
	open, cancel := context.WithTimeout(ctx, startup)
	defer cancel()
	header := http.Header{"Authorization": {"Bearer " + cfg.Key}}
	conn, _, err := websocket.Dial(open, uri.String(), &websocket.DialOptions{HTTPHeader: header, HTTPClient: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}})
	if err != nil {
		return nil, fmt.Errorf("connect GPT-Live: %w", err)
	}
	conn.SetReadLimit(32768)
	cfg.Key = ""
	control, stop := context.WithCancel(context.WithoutCancel(ctx))
	audio, mute := context.WithCancel(ctx)
	s := &session{cfg: cfg, conn: conn, ctx: control, cancel: stop, mute: mute, budget: release, parent: ctx, clock: media.NewClock(24000), events: make(chan engine.Event, 64), ready: make(chan error, 1), final: make(chan struct{}), end: make(chan struct{}), reader: make(chan struct{}), ticker: make(chan struct{}), gate: make(chan struct{}, 1), start: "start_" + id, stream: "local_" + id, commands: make(map[string]*command), delegations: make(map[string]delegation)}
	s.gate <- struct{}{}
	go func() { defer close(s.ticker); s.clock.Run(audio) }()
	go s.read()
	go func() {
		select {
		case <-ctx.Done():
			s.begin()
		case <-s.end:
		}
	}()
	var authority any
	if cfg.Delegation == "client" {
		authority = map[string]string{"type": "client"}
	}
	if err := s.write(open, map[string]any{"type": "session.start", "event_id": s.start, "session": map[string]any{"model": cfg.Model, "instructions": cfg.Instructions, "store": false, "delegation": authority, "audio": map[string]any{"format": map[string]any{"type": "audio/pcm", "rate": 24000}, "output": map[string]any{"voice": cfg.Voice}}}}); err != nil {
		return nil, errors.Join(err, s.Close())
	}
	select {
	case err := <-s.ready:
		if err != nil {
			return nil, errors.Join(err, s.Close())
		}
	case <-open.Done():
		return nil, errors.Join(open.Err(), s.Close())
	}
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(err, s.Close())
	}
	owned = true
	return s, nil
}

type session struct {
	cfg         engine.Config
	conn        *websocket.Conn
	ctx         context.Context
	cancel      context.CancelFunc
	mute        context.CancelFunc
	budget      context.CancelFunc
	parent      context.Context
	clock       *media.Clock
	events      chan engine.Event
	ready       chan error
	final       chan struct{}
	end         chan struct{}
	reader      chan struct{}
	ticker      chan struct{}
	start       string
	stream      string
	remote      string
	closeID     string
	once        sync.Once
	readyOnce   sync.Once
	finalOnce   sync.Once
	started     atomic.Bool
	closed      atomic.Bool
	confirmed   atomic.Bool
	gate        chan struct{}
	eventMu     sync.Mutex
	finished    bool
	err         error
	seq         atomic.Uint64
	input       atomic.Uint64
	output      atomic.Uint64
	partial     atomic.Uint64
	carry       []byte
	mu          sync.Mutex
	commands    map[string]*command
	order       []string
	receipt     *engine.Usage
	delegations map[string]delegation
}

type delegation struct {
	event  string
	offset float64
}

func (s *session) PushAudio(ctx context.Context, pcm []byte) error {
	if s.closed.Load() || s.parent.Err() != nil || !s.started.Load() {
		return errors.New("GPT-Live input is not active")
	}
	if len(pcm) != 960 {
		return errors.New("GPT-Live input requires mono PCM16 24 kHz, exactly 20 ms")
	}
	if err := s.write(ctx, map[string]any{"type": "session.input_audio.append", "audio": base64.StdEncoding.EncodeToString(pcm)}); err != nil {
		s.begin()
		return err
	}
	s.input.Add(uint64(len(pcm)))
	return nil
}

func (*session) Commit(context.Context) error {
	return errors.New("GPT-Live has native continuous endpointing; manual commit is unsupported")
}
func (*session) Interrupt(context.Context, string, time.Duration) error {
	return errors.New("GPT-Live exposes no exact measured-playout truncation or manual response cancellation")
}
func (s *session) Audio() <-chan engine.Frame  { return s.clock.Output() }
func (s *session) Events() <-chan engine.Event { return s.events }
func (s *session) Stats() engine.Stats {
	frames, underruns := s.clock.Stats()
	loss := s.clock.Loss()
	return engine.Stats{InputBytes: s.input.Load(), OutputBytes: s.output.Load(), Frames: frames, Underruns: underruns, DroppedBytes: loss.DroppedBytes + s.partial.Load(), DroppedFrames: loss.DroppedFrames, InvalidChunks: loss.InvalidChunks, QueuedBytes: loss.QueuedBytes}
}

func (s *session) Close() error {
	s.begin()
	select {
	case <-s.end:
		return s.err
	case <-time.After(closing + 300*time.Millisecond):
		return errors.Join(errFinal, errors.New("GPT-Live local cleanup is unconfirmed"))
	}
}
func (s *session) Usage() (engine.Usage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.receipt == nil {
		return engine.Usage{}, errFinal
	}
	return *s.receipt, nil
}
func (s *session) begin() {
	s.once.Do(func() {
		s.closed.Store(true)
		s.mute()
		go s.close()
	})
}
func (s *session) close() {
	defer close(s.end)
	defer s.budget()
	ctx, cancel := context.WithTimeout(context.Background(), closing)
	defer cancel()
	if s.started.Load() && !s.confirmed.Load() {
		id, err := random()
		if err == nil {
			s.mu.Lock()
			s.closeID = "close_" + id
			id = s.closeID
			s.mu.Unlock()
			err = s.write(ctx, map[string]any{"type": "session.close", "event_id": id})
		}
		if err != nil {
			s.err = errors.Join(errFinal, err)
		}
		if err == nil {
			select {
			case <-s.final:
			case <-ctx.Done():
				s.err = errFinal
			}
		}
	}
	if !s.confirmed.Load() {
		s.err = errors.Join(s.err, errFinal)
	}
	s.cancel()
	if err := s.conn.CloseNow(); err != nil {
		s.err = errors.Join(s.err, err)
	}
	for _, done := range []<-chan struct{}{s.reader, s.ticker} {
		select {
		case <-done:
		case <-time.After(100 * time.Millisecond):
			s.err = errors.Join(s.err, errors.New("GPT-Live local owner did not terminate"))
		}
	}
}

func (s *session) write(ctx context.Context, value map[string]any) error {
	return s.send(ctx, value, nil)
}
func (s *session) send(ctx context.Context, value map[string]any, check func() bool) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.gate:
	}
	defer func() { s.gate <- struct{}{} }()
	if err := ctx.Err(); err != nil {
		return err
	}
	if check != nil && !check() {
		return errAppend
	}
	if value["type"] != "session.close" && (s.closed.Load() || s.parent.Err() != nil) {
		return errors.New("GPT-Live input is fenced")
	}
	return s.conn.Write(ctx, websocket.MessageText, raw)
}

func (s *session) read() {
	defer close(s.reader)
	defer s.finish()
	for {
		kind, raw, err := s.conn.Read(s.ctx)
		if err != nil {
			if !s.closed.Load() {
				s.fail("GPT-Live transport ended before confirmed session closure")
			}
			s.resolve(errors.New("GPT-Live startup transport ended"))
			return
		}
		var msg message
		if kind != websocket.MessageText || !utf8.Valid(raw) || json.Unmarshal(raw, &msg) != nil || msg.Type == "" {
			s.fail("invalid GPT-Live server event")
			return
		}
		if !s.handle(msg) {
			return
		}
	}
}

func (s *session) handle(msg message) bool {
	if msg.Type == "session.started" {
		if s.started.Load() || !identifier(msg.EventID) || (msg.ClientID != "" && msg.ClientID != s.start) || !identifier(msg.Session.ID) || msg.Session.Model != s.cfg.Model || (msg.Session.Store != nil && *msg.Session.Store) || (msg.Session.Status != "" && msg.Session.Status != "active") || msg.Session.Audio.Format.Type != "audio/pcm" || msg.Session.Audio.Format.Rate != 24000 || msg.Session.Audio.Output.Voice != s.cfg.Voice || !policy(msg.Session.Delegation) || s.cfg.Delegation == "client" && (len(msg.Session.Delegation) == 0 || string(msg.Session.Delegation) == "null") {
			s.fail("GPT-Live resolved startup configuration was not confirmed")
			return false
		}
		s.remote = msg.Session.ID
		s.started.Store(true)
		s.resolve(nil)
		s.emit(engine.Event{Type: "session.started", Session: s.remote, Data: map[string]any{"eventID": msg.EventID, "model": s.cfg.Model, "localStream": s.stream}})
		return true
	}
	if !s.started.Load() {
		s.fail("GPT-Live sent application data before session.started")
		return false
	}
	if msg.Type == "session.closed" {
		s.mu.Lock()
		known := msg.ClientID == "" || msg.ClientID == s.closeID
		s.mu.Unlock()
		if !known || !identifier(msg.EventID) || msg.Session.ID != s.remote || msg.Session.Model != s.cfg.Model || !reason(msg.Reason) || msg.Usage.Seconds == nil || *msg.Usage.Seconds < 0 || *msg.Usage.Seconds > 24*60*60 {
			s.fail("GPT-Live final usage identity was not confirmed")
			return false
		}
		s.mu.Lock()
		s.receipt = &engine.Usage{Session: s.remote, EventID: msg.EventID, Model: msg.Session.Model, Reason: msg.Reason, Seconds: *msg.Usage.Seconds, At: time.Now()}
		s.mu.Unlock()
		s.confirmed.Store(true)
		s.emit(engine.Event{Type: "session.closed", Session: s.remote, Data: map[string]any{"event_id": msg.EventID, "reason": msg.Reason, "usage": map[string]any{"seconds": *msg.Usage.Seconds}}})
		s.finalOnce.Do(func() { close(s.final) })
		s.begin()
		return false
	}
	if msg.Type == "session.usage.updated" {
		if !identifier(msg.EventID) || msg.Usage.Seconds == nil || *msg.Usage.Seconds < 0 || *msg.Usage.Seconds > 24*60*60 {
			s.fail("invalid GPT-Live cumulative usage observation")
			return false
		}
		s.emit(engine.Event{Type: msg.Type, Session: s.remote, Data: map[string]any{"event_id": msg.EventID, "usage": map[string]any{"seconds": *msg.Usage.Seconds}}})
		return true
	}
	if s.closed.Load() {
		return true
	}
	if s.ack(msg) {
		return true
	}
	switch msg.Type {
	case "session.output_audio.delta":
		if len(msg.Delta) > 6400 {
			s.fail("GPT-Live output exceeded bounded media allowance")
			return false
		}
		pcm, err := base64.StdEncoding.DecodeString(msg.Delta)
		if err != nil || base64.StdEncoding.EncodeToString(pcm) != msg.Delta || len(pcm) == 0 {
			s.fail("invalid GPT-Live PCM output")
			return false
		}
		s.output.Add(uint64(len(pcm)))
		if len(s.carry) > 0 {
			pcm = append(s.carry, pcm...)
		}
		s.carry = nil
		if len(pcm)%2 != 0 {
			s.carry = append([]byte(nil), pcm[len(pcm)-1:]...)
			pcm = pcm[:len(pcm)-1]
		}
		if len(pcm) == 0 {
			return true
		}
		// Primary Live audio has no provider item, turn, timing or audio-done.
		// This identity is local source attribution only; never seal a tail.
		if !s.clock.Submit(media.Chunk{Item: s.stream, PCM: pcm}) {
			s.fail("GPT-Live output exceeded bounded media allowance")
			return false
		}
	case "session.input_transcript.delta", "session.output_transcript.delta":
		if !identifier(msg.EventID) || len(msg.Delta) > 8192 || !timeline(msg.Start, msg.End) {
			s.fail("invalid GPT-Live transcript fragment")
			return false
		}
		kind := "transcript.input.delta"
		if msg.Type == "session.output_transcript.delta" {
			kind = "transcript.output.delta"
		}
		data := map[string]any{"type": msg.Type, "delta": msg.Delta, "event_id": msg.EventID, "start_ms": *msg.Start, "end_ms": *msg.End, "completeTurn": false}
		if msg.ClientID != "" {
			if !identifier(msg.ClientID) {
				s.fail("invalid GPT-Live transcript correlation")
				return false
			}
			data["client_event_id"] = msg.ClientID
		}
		s.emit(engine.Event{Type: kind, Item: msg.EventID, Text: msg.Delta, Data: data})
	case "session.delegation.created":
		if s.cfg.Delegation != "client" || !identifier(msg.EventID) || !identifier(msg.Delegation.ID) || msg.Delegation.Type != "delegation" || msg.Delegation.Target != "client" || msg.Offset == nil || *msg.Offset < 0 || *msg.Offset > 24*60*60*1000 {
			s.fail("invalid GPT-Live delegation metadata")
			return false
		}
		s.mu.Lock()
		prior, exists := s.delegations[msg.Delegation.ID]
		for id, known := range s.delegations {
			if id != msg.Delegation.ID && known.event == msg.EventID {
				s.mu.Unlock()
				s.fail("GPT-Live delegation server event identity was reused")
				return false
			}
		}
		if exists && (prior.event != msg.EventID || prior.offset != *msg.Offset) || !exists && len(s.delegations) >= 256 {
			s.mu.Unlock()
			s.fail("GPT-Live delegation identity was reused or allowance exhausted")
			return false
		}
		if exists {
			s.mu.Unlock()
			return true
		}
		s.delegations[msg.Delegation.ID] = delegation{event: msg.EventID, offset: *msg.Offset}
		s.mu.Unlock()
		s.emit(engine.Event{Type: msg.Type, Item: msg.Delegation.ID, Data: map[string]any{"event_id": msg.EventID, "offset_ms": *msg.Offset, "delegation": map[string]any{"id": msg.Delegation.ID, "type": msg.Delegation.Type, "target": msg.Delegation.Target}}})
	case "error":
		s.fail("OpenAI rejected or could not complete a GPT-Live operation")
		return false
	default:
		// Backend response events cannot establish a voice source boundary.
		s.emit(engine.Event{Type: "live.event", Data: map[string]any{"type": msg.Type, "eventID": msg.EventID}})
	}
	return true
}

func (s *session) fail(text string) {
	s.resolve(errors.New(text))
	s.begin()
	s.emit(engine.Event{Type: "engine.error", Text: text})
}
func (s *session) resolve(err error) { s.readyOnce.Do(func() { s.ready <- err }) }
func (s *session) emit(event engine.Event) {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	if s.finished {
		return
	}
	event.Seq = s.seq.Add(1)
	event.At = time.Now()
	select {
	case s.events <- event:
	default:
		s.begin()
	}
}
func (s *session) finish() {
	s.partial.Add(uint64(len(s.carry)))
	s.carry = nil
	s.settle()
	s.eventMu.Lock()
	s.finished = true
	close(s.events)
	s.eventMu.Unlock()
}

func address(uri *url.URL) bool {
	if uri == nil || uri.User != nil || uri.RawQuery != "" || uri.ForceQuery || uri.Fragment != "" || uri.Path != "/v1/live/sessions" {
		return false
	}
	if uri.Scheme == "wss" && uri.Host == "api.openai.com" {
		return true
	}
	ip := net.ParseIP(uri.Hostname())
	return uri.Scheme == "ws" && (uri.Hostname() == "localhost" || (ip != nil && ip.IsLoopback()))
}
func identifier(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, char := range id {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-') {
			return false
		}
	}
	return true
}
func random() (string, error) {
	data := make([]byte, 16)
	_, err := rand.Read(data)
	return hex.EncodeToString(data), err
}
func policy(raw json.RawMessage) bool {
	if len(raw) == 0 || string(raw) == "null" {
		return true
	}
	var value struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(raw, &value) == nil && value.Type == "client"
}
func timeline(start, end *float64) bool {
	return start != nil && end != nil && *start >= 0 && *end >= *start && *end <= 24*60*60*1000
}
func reason(value string) bool {
	return value == "close_requested" || value == "expired" || value == "content" || value == "remote_hangup" || value == "connection_lost"
}

type message struct {
	Type     string   `json:"type"`
	EventID  string   `json:"event_id"`
	ClientID string   `json:"client_event_id"`
	Delta    string   `json:"delta"`
	Start    *float64 `json:"start_ms"`
	End      *float64 `json:"end_ms"`
	Reason   string   `json:"reason"`
	Usage    struct {
		Seconds *float64 `json:"seconds"`
	} `json:"usage"`
	Offset     *float64 `json:"offset_ms"`
	Delegation struct {
		ID     string `json:"id"`
		Type   string `json:"type"`
		Target string `json:"target"`
	} `json:"delegation"`
	Session struct {
		ID         string          `json:"id"`
		Model      string          `json:"model"`
		Status     string          `json:"status"`
		Store      *bool           `json:"store"`
		Delegation json.RawMessage `json:"delegation"`
		Audio      struct {
			Format struct {
				Type string `json:"type"`
				Rate int    `json:"rate"`
			} `json:"format"`
			Output struct {
				Voice string `json:"voice"`
			} `json:"output"`
		} `json:"audio"`
	} `json:"session"`
	Error struct {
		ClientID string `json:"client_event_id"`
	} `json:"error"`
}
