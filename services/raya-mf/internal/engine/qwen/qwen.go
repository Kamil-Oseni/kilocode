// raya_change - Qwen Omni Realtime adapter isolated behind Raya's Voice Engine Interface.
package qwen

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/media"
	"github.com/coder/websocket"
)

const endpoint = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime"

type Engine struct{}

func (Engine) Descriptor() engine.Descriptor {
	return engine.Descriptor{
		ID:                      "qwen-realtime",
		AcceptsTruncation:       false,
		NativeBargeIn:           true,
		NativeEndpointing:       true,
		RequiresContinuousInput: true,
		InputRate:               16000,
		OutputRate:              24000,
	}
}

func (e Engine) Open(ctx context.Context, cfg engine.Config) (engine.Session, error) {
	if cfg.Key == "" {
		return nil, errors.New("qwen realtime key is required")
	}
	if cfg.Model == "" {
		cfg.Model = "qwen-audio-3.0-realtime-plus"
	}
	raw := cfg.Endpoint
	if raw == "" {
		raw = endpoint
	}
	uri, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse qwen endpoint: %w", err)
	}
	query := uri.Query()
	query.Set("model", cfg.Model)
	uri.RawQuery = query.Encode()
	header := http.Header{}
	header.Set("Authorization", "Bearer "+cfg.Key)
	conn, _, err := websocket.Dial(ctx, uri.String(), &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, fmt.Errorf("connect qwen realtime: %w", err)
	}
	run, cancel := context.WithCancel(ctx)
	session := &Session{
		cfg:    cfg,
		conn:   conn,
		ctx:    run,
		cancel: cancel,
		clock:  media.NewClock(e.Descriptor().OutputRate),
		events: make(chan engine.Event, 64),
		ready:  make(chan error, 1),
	}
	session.wait.Add(2)
	go func() {
		defer session.wait.Done()
		session.clock.Run(run)
	}()
	go func() {
		defer session.wait.Done()
		defer close(session.events)
		session.read()
	}()
	if err := session.write(ctx, sessionUpdate(cfg)); err != nil {
		_ = session.Close()
		return nil, err
	}
	select {
	case err := <-session.ready:
		if err != nil {
			_ = session.Close()
			return nil, err
		}
	case <-ctx.Done():
		_ = session.Close()
		return nil, ctx.Err()
	case <-time.After(5 * time.Second):
		_ = session.Close()
		return nil, errors.New("qwen realtime session update timed out")
	}
	return session, nil
}

type Session struct {
	cfg        engine.Config
	conn       *websocket.Conn
	ctx        context.Context
	cancel     context.CancelFunc
	clock      *media.Clock
	events     chan engine.Event
	ready      chan error
	readyOnce  sync.Once
	writeMu    sync.Mutex
	itemsMu    sync.RWMutex
	items      []engine.ContextItem
	wait       sync.WaitGroup
	seq        atomic.Uint64
	input      atomic.Uint64
	output     atomic.Uint64
	interrupts atomic.Uint64
	once       sync.Once
}

func (s *Session) PushAudio(ctx context.Context, pcm []byte) error {
	if len(pcm) == 0 {
		return nil
	}
	s.input.Add(uint64(len(pcm)))
	return s.write(ctx, map[string]any{
		"event_id": cryptoID(),
		"type":     "input_audio_buffer.append",
		"audio":    base64.StdEncoding.EncodeToString(pcm),
	})
}

func (s *Session) Commit(ctx context.Context) error {
	if s.cfg.Mode != "push-to-talk" {
		return nil
	}
	if err := s.write(ctx, map[string]any{"event_id": cryptoID(), "type": "input_audio_buffer.commit"}); err != nil {
		return err
	}
	return s.write(ctx, map[string]any{"event_id": cryptoID(), "type": "response.create"})
}

func (s *Session) Audio() <-chan engine.Frame {
	return s.clock.Output()
}

func (s *Session) Events() <-chan engine.Event {
	return s.events
}

func (s *Session) Interrupt(ctx context.Context, reason string, heard time.Duration) error {
	s.interrupts.Add(1)
	if err := s.write(ctx, map[string]any{"event_id": cryptoID(), "type": "response.cancel"}); err != nil {
		return err
	}
	s.emit(engine.Event{Type: "response.interrupted", HeardMS: heard.Milliseconds(), Data: map[string]any{
		"reason":            reason,
		"contextTruncated":  false,
		"capabilityMissing": "measured-playout truncation",
	}})
	return nil
}

func (s *Session) Inject(ctx context.Context, item engine.ContextItem) error {
	if item.Created.IsZero() {
		item.Created = time.Now()
	}
	ttl := time.Duration(item.TTLMS) * time.Millisecond
	if ttl > 0 && time.Since(item.Created) >= ttl {
		s.emit(engine.Event{Type: "context.expired", Item: item.ID, Data: map[string]any{"kind": item.Kind}})
		return nil
	}
	content := map[string]any{"type": "input_text", "text": "[" + item.Kind + "] " + item.Text}
	payload := map[string]any{
		"event_id": cryptoID(),
		"type":     "conversation.item.create",
		"item": map[string]any{
			"id":      item.ID,
			"type":    "message",
			"role":    "system",
			"content": []map[string]any{content},
		},
	}
	if item.Kind == "delegation.result" && item.Call != "" {
		payload["item"] = map[string]any{
			"id":      item.ID,
			"type":    "function_call_output",
			"call_id": item.Call,
			"output":  item.Text,
		}
	}
	if err := s.write(ctx, payload); err != nil {
		return err
	}
	s.itemsMu.Lock()
	s.items = append(s.items, item)
	s.itemsMu.Unlock()
	s.emit(engine.Event{Type: "context.injected", Item: item.ID, Data: map[string]any{"kind": item.Kind}})
	if item.Kind != "delegation.result" {
		return nil
	}
	return s.write(ctx, map[string]any{"event_id": cryptoID(), "type": "response.create"})
}

func (s *Session) Snapshot(context.Context) (engine.Snapshot, error) {
	s.itemsMu.RLock()
	defer s.itemsMu.RUnlock()
	items := make([]engine.ContextItem, len(s.items))
	copy(items, s.items)
	return engine.Snapshot{Items: items}, nil
}

func (s *Session) Prefill(ctx context.Context, snapshot engine.Snapshot) error {
	for _, item := range snapshot.Items {
		if err := s.Inject(ctx, item); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) Stats() engine.Stats {
	frames, underruns := s.clock.Stats()
	return engine.Stats{
		InputBytes:  s.input.Load(),
		OutputBytes: s.output.Load(),
		Frames:      frames,
		Underruns:   underruns,
		Interrupts:  s.interrupts.Load(),
	}
}

func (s *Session) Close() error {
	var err error
	s.once.Do(func() {
		s.cancel()
		err = s.conn.Close(websocket.StatusNormalClosure, "session closed")
		s.wait.Wait()
	})
	return err
}

func (s *Session) read() {
	for {
		_, raw, err := s.conn.Read(s.ctx)
		if err != nil {
			if s.ctx.Err() == nil {
				s.emit(engine.Event{Type: "engine.error", Text: err.Error()})
			}
			return
		}
		var msg message
		if err := json.Unmarshal(raw, &msg); err != nil {
			s.emit(engine.Event{Type: "engine.error", Text: "invalid qwen event: " + err.Error()})
			continue
		}
		s.handle(msg)
	}
}

func (s *Session) handle(msg message) {
	switch msg.Type {
	case "session.created", "response.created":
		s.emit(engine.Event{Type: msg.Type, Session: msg.Session.ID, Data: msg.Data()})
	case "session.updated":
		s.readyOnce.Do(func() { s.ready <- nil })
		s.emit(engine.Event{Type: msg.Type, Session: msg.Session.ID, Data: msg.Data()})
	case "input_audio_buffer.speech_started":
		s.emit(engine.Event{Type: "speech.started", Item: msg.ItemID})
	case "input_audio_buffer.speech_stopped":
		s.emit(engine.Event{Type: "speech.stopped", Item: msg.ItemID, Data: map[string]any{"reason": msg.Reason}})
	case "conversation.item.input_audio_transcription.delta":
		s.emit(engine.Event{Type: "transcript.input.delta", Item: msg.ItemID, Text: msg.Delta})
	case "conversation.item.input_audio_transcription.completed":
		s.emit(engine.Event{Type: "transcript.input.done", Item: msg.ItemID, Text: first(msg.Transcript, msg.Text), Stable: true})
	case "response.audio_transcript.delta":
		s.emit(engine.Event{Type: "transcript.output.delta", Item: msg.ItemID, Text: msg.Delta})
	case "response.audio_transcript.done":
		s.emit(engine.Event{Type: "transcript.output.done", Item: msg.ItemID, Text: first(msg.Transcript, msg.Text), Stable: true})
	case "response.audio.delta":
		pcm, err := base64.StdEncoding.DecodeString(msg.Delta)
		if err != nil {
			s.emit(engine.Event{Type: "engine.error", Text: "invalid qwen audio: " + err.Error()})
			return
		}
		s.output.Add(uint64(len(pcm)))
		select {
		case s.clock.Input() <- media.Chunk{Item: msg.ItemID, PCM: pcm}:
		default:
			s.emit(engine.Event{Type: "audio.dropped", Item: msg.ItemID, Data: map[string]any{"bytes": len(pcm)}})
		}
	case "response.function_call_arguments.done":
		s.emit(engine.Event{Type: "delegation.request", Item: msg.ItemID, Text: msg.Arguments, Data: map[string]any{
			"call": msg.CallID,
			"name": msg.Name,
		}})
	case "response.done":
		s.emit(engine.Event{Type: "response.done", Data: map[string]any{"status": msg.Response.Status}})
	case "error":
		err := errors.New(first(msg.Error.Message, msg.Message))
		s.readyOnce.Do(func() { s.ready <- err })
		s.emit(engine.Event{Type: "engine.error", Text: err.Error()})
	}
}

func (s *Session) emit(event engine.Event) {
	event.Seq = s.seq.Add(1)
	event.At = time.Now()
	select {
	case s.events <- event:
	case <-s.ctx.Done():
	default:
	}
}

func (s *Session) write(ctx context.Context, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode qwen event: %w", err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := s.conn.Write(ctx, websocket.MessageText, raw); err != nil {
		return fmt.Errorf("write qwen event: %w", err)
	}
	return nil
}

type message struct {
	Type       string `json:"type"`
	ItemID     string `json:"item_id"`
	Delta      string `json:"delta"`
	Text       string `json:"text"`
	Transcript string `json:"transcript"`
	Reason     string `json:"reason"`
	Arguments  string `json:"arguments"`
	CallID     string `json:"call_id"`
	Name       string `json:"name"`
	Message    string `json:"message"`
	Session    struct {
		ID string `json:"id"`
	} `json:"session"`
	Response struct {
		Status string `json:"status"`
	} `json:"response"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (m message) Data() map[string]any {
	return map[string]any{"vendorType": m.Type}
}

func sessionUpdate(cfg engine.Config) map[string]any {
	mode := any(map[string]any{
		"type":                "smart_turn",
		"threshold":           cfg.Threshold,
		"silence_duration_ms": cfg.Silence.Milliseconds(),
	})
	if cfg.Mode == "push-to-talk" {
		mode = nil
	}
	return map[string]any{
		"event_id": cryptoID(),
		"type":     "session.update",
		"session": map[string]any{
			"modalities":          []string{"text", "audio"},
			"voice":               cfg.Voice,
			"instructions":        cfg.Instructions,
			"input_audio_format":  "pcm",
			"output_audio_format": "pcm",
			"input_audio_transcription": map[string]any{
				"model": "fun-asr",
			},
			"turn_detection": mode,
			"tools": []map[string]any{{
				"type": "function",
				"function": map[string]any{
					"name":        "delegate",
					"description": "Request grounded reasoning or a read-only coding action from Raya's asynchronous plane.",
					"parameters": map[string]any{
						"type":       "object",
						"properties": map[string]any{"request": map[string]any{"type": "string"}},
						"required":   []string{"request"},
					},
				},
			}},
			"tool_choice": "auto",
		},
	}
}

func cryptoID() string {
	return fmt.Sprintf("evt_%d", time.Now().UnixNano())
}

func first(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
