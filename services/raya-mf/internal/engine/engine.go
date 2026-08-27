// raya_change - Architecture-faithful voice engine boundary for Raya's media plane.
package engine

import (
	"context"
	"time"
)

const FramePeriod = 20 * time.Millisecond

type Config struct {
	Endpoint     string
	Key          string
	Model        string
	Voice        string
	Instructions string
	Mode         string
	Threshold    float64
	Silence      time.Duration
}

type Descriptor struct {
	ID                      string  `json:"id"`
	AcceptsTruncation       bool    `json:"acceptsTruncation"`
	NativeBargeIn           bool    `json:"nativeBargeIn"`
	NativeEndpointing       bool    `json:"nativeEndpointing"`
	RequiresContinuousInput bool    `json:"requiresContinuousInput"`
	InputRate               int     `json:"inputRate"`
	OutputRate              int     `json:"outputRate"`
	CostPerMinute           float64 `json:"costPerMinute,omitempty"`
}

type Frame struct {
	Item string
	PCM  []byte
	Rate int
	At   time.Time
}

type Event struct {
	Seq       uint64         `json:"seq"`
	Type      string         `json:"type"`
	Session   string         `json:"session,omitempty"`
	Turn      string         `json:"turn,omitempty"`
	Item      string         `json:"item,omitempty"`
	Text      string         `json:"text,omitempty"`
	Stable    bool           `json:"stable,omitempty"`
	Truncated bool           `json:"truncated,omitempty"`
	HeardMS   int64          `json:"heardMs,omitempty"`
	At        time.Time      `json:"at"`
	Data      map[string]any `json:"data,omitempty"`
}

type ContextItem struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"`
	Text       string    `json:"text"`
	Call       string    `json:"call,omitempty"`
	TTLMS      int64     `json:"ttl,omitempty"`
	Created    time.Time `json:"created"`
	Supersedes string    `json:"supersedes,omitempty"`
}

type Snapshot struct {
	Items []ContextItem `json:"items"`
}

type Stats struct {
	InputBytes  uint64 `json:"inputBytes"`
	OutputBytes uint64 `json:"outputBytes"`
	Frames      uint64 `json:"frames"`
	Underruns   uint64 `json:"underruns"`
	Interrupts  uint64 `json:"interrupts"`
}

type Engine interface {
	Descriptor() Descriptor
	Open(context.Context, Config) (Session, error)
}

type Session interface {
	PushAudio(context.Context, []byte) error
	Commit(context.Context) error
	Audio() <-chan Frame
	Events() <-chan Event
	Interrupt(context.Context, string, time.Duration) error
	Inject(context.Context, ContextItem) error
	Snapshot(context.Context) (Snapshot, error)
	Prefill(context.Context, Snapshot) error
	Stats() Stats
	Close() error
}
