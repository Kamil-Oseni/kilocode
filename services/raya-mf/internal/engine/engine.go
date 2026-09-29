// raya_change - Architecture-faithful voice engine boundary for Raya's media plane.
package engine

import (
	"context"
	"errors"
	"time"
)

const FramePeriod = 20 * time.Millisecond

type Config struct {
	Provider       string  `json:"provider,omitempty"`
	Delegation     string  `json:"delegation,omitempty"`
	MaximumSeconds float64 `json:"maximumSeconds,omitempty"`
	Endpoint       string
	Key            string
	Model          string
	Voice          string
	Instructions   string
	Mode           string
	Threshold      float64
	Silence        time.Duration
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
	Turn  string
	Final bool
	Epoch uint64
	Seq   uint64
	Start uint64
	End   uint64
	Item  string
	PCM   []byte
	Rate  int
	At    time.Time
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
	Replaces   []string  `json:"replaces,omitempty"`
}

type Snapshot struct {
	Version int             `json:"version,omitempty"`
	Items   []ContextItem   `json:"items"`
	Context []ContextRecord `json:"context,omitempty"`
}

// ContextRecord preserves the exact append projection, not a provider checkpoint.
type ContextRecord struct {
	Item    ContextItem `json:"item"`
	Label   string      `json:"label"`
	Content string      `json:"content"`
	Expired string      `json:"expired,omitempty"`
}

type Stats struct {
	InputBytes    uint64 `json:"inputBytes"`
	OutputBytes   uint64 `json:"outputBytes"`
	Frames        uint64 `json:"frames"`
	Underruns     uint64 `json:"underruns"`
	Interrupts    uint64 `json:"interrupts"`
	DroppedBytes  uint64 `json:"droppedBytes"`
	DroppedFrames uint64 `json:"droppedFrames"`
	InvalidChunks uint64 `json:"invalidChunks"`
	QueuedBytes   uint64 `json:"queuedBytes"`
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

// Terminal exposes a confirmed provider receipt after local capture has stopped.
// It grants no media or work authority and never infers usage from local time.
type Terminal interface {
	Usage() (Usage, error)
}

type Startup struct {
	Session string
	EventID string
	Model   string
	At      time.Time
}

// Preparation exposes exact observed configuration and current local readiness.
type Preparation interface {
	Startup() (Startup, error)
	Active() bool
}

// OpenError retains immutable setup observations after failed provider admission.
// Attempted is not a billing claim; Released does not confirm provider usage.
type OpenError struct {
	err       error
	attempted bool
	released  bool
	startup   *Startup
	usage     *Usage
}

func NewOpenError(err error, attempted, released bool, startup *Startup, usage *Usage) *OpenError {
	result := &OpenError{err: err, attempted: attempted, released: released}
	if startup != nil {
		copy := *startup
		result.startup = &copy
	}
	if usage != nil {
		copy := *usage
		result.usage = &copy
	}
	return result
}

func (e *OpenError) Error() string   { return e.err.Error() }
func (e *OpenError) Unwrap() error   { return e.err }
func (e *OpenError) Attempted() bool { return e.attempted }
func (e *OpenError) Released() bool  { return e.released }
func (e *OpenError) Startup() (Startup, error) {
	if e.startup == nil {
		return Startup{}, errors.New("provider startup receipt is unconfirmed")
	}
	return *e.startup, nil
}
func (e *OpenError) Usage() (Usage, error) {
	if e.usage == nil {
		return Usage{}, errors.New("final provider usage receipt is unconfirmed")
	}
	return *e.usage, nil
}

// Delegator resolves only original client-delegation IDs observed by this session.
// Successful acceptance does not imply spoken output or completed playback.
type Delegator interface {
	Result(context.Context, Result) error
}

type Result struct {
	DelegationID string    `json:"delegationID"`
	ReceiptID    string    `json:"receiptID"`
	Kind         string    `json:"kind"`
	Content      string    `json:"content"`
	TTLMS        int64     `json:"ttl"`
	Created      time.Time `json:"created"`
}

type Usage struct {
	Session string
	EventID string
	Model   string
	Reason  string
	Seconds float64
	At      time.Time
}
