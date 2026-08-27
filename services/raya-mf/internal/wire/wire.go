// raya_change - Stable wire contracts between Raya's real-time, async, and client planes.
package wire

import (
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

type Start struct {
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
	Session string `json:"session"`
	Item    string `json:"item"`
	Samples uint64 `json:"samples"`
	Rate    int    `json:"rate"`
	Jitter  int    `json:"jitterMs"`
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
