// raya_change - Stable wire contracts between Raya's real-time, async, and client planes.
package wire

import (
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

type Start struct {
	Version      int           `json:"version,omitempty"`
	ID           string        `json:"id"`
	Room         string        `json:"room"`
	LiveKitURL   string        `json:"livekitUrl"`
	LiveKitToken string        `json:"livekitToken"`
	BackendURL   string        `json:"backendUrl"`
	BackendAuth  string        `json:"backendAuthorization"`
	Directory    string        `json:"directory"`
	Engine       engine.Config `json:"engine"`
}

type Started struct {
	ID         string            `json:"id"`
	Descriptor engine.Descriptor `json:"descriptor"`
	StartedAt  time.Time         `json:"startedAt"`
}

type Envelope struct {
	Session string       `json:"session"`
	Seq     uint64       `json:"seq"`
	Event   engine.Event `json:"event"`
}

type Inject struct {
	Item engine.ContextItem `json:"item"`
}

type Playout struct {
	Turn    string `json:"turn,omitempty"`
	Final   bool   `json:"final,omitempty"`
	Version int    `json:"version"`
	Epoch   uint64 `json:"epoch"`
	Seq     uint64 `json:"seq"`
	Session string `json:"session"`
	Item    string `json:"item"`
	Samples uint64 `json:"samples"`
	Rate    int    `json:"rate"`
	Jitter  int    `json:"jitterMs"`
}

// Span identifies published source samples, never proof that a client heard them.
type Span struct {
	Turn    string `json:"turn,omitempty"`
	Final   bool   `json:"final,omitempty"`
	Version int    `json:"version"`
	Session string `json:"session"`
	Item    string `json:"item"`
	Epoch   uint64 `json:"epoch"`
	Seq     uint64 `json:"seq"`
	Start   uint64 `json:"start"`
	End     uint64 `json:"end"`
	Rate    int    `json:"rate"`
}

type Discontinuity struct {
	Type    string `json:"type"`
	Item    string `json:"item"`
	HeardMS int64  `json:"heardMs"`
}

type Transcript struct {
	Type      string `json:"type"`
	Turn      string `json:"turn"`
	Item      string `json:"item"`
	Text      string `json:"text"`
	Stable    bool   `json:"stable"`
	Truncated bool   `json:"truncated"`
}

// Failure carries a stable category and recovery action, never a provider payload.
type Failure struct {
	Code     string    `json:"code"`
	Message  string    `json:"message"`
	Recovery string    `json:"recovery"`
	At       time.Time `json:"at"`
}
type Status struct {
	ID            string   `json:"id"`
	State         string   `json:"state"`
	Failure       *Failure `json:"failure,omitempty"`
	RoomReport    string   `json:"roomReport,omitempty"`
	BackendReport string   `json:"backendReport,omitempty"`
	Cleanup       string   `json:"cleanup,omitempty"`
}
