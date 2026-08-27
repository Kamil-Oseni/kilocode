// raya_change - Deadline-bounded async-plane event transport; audio never crosses this boundary.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	urlpkg "net/url"
	"strings"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type Backend interface {
	Event(context.Context, wire.Envelope) error
}

type HTTPBackend struct {
	URL       string
	Auth      string
	Directory string
	Client    *http.Client
}

func (b HTTPBackend) Event(ctx context.Context, event wire.Envelope) error {
	if b.URL == "" {
		return nil
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode voice event: %w", err)
	}
	url := strings.TrimRight(b.URL, "/") + "/kilocode/voice/events"
	if b.Directory != "" {
		url += "?directory=" + urlpkg.QueryEscape(b.Directory)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("create voice event request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if b.Auth != "" {
		req.Header.Set("Authorization", b.Auth)
	}
	client := b.Client
	if client == nil {
		client = &http.Client{Timeout: 150 * time.Millisecond}
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("send voice event: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("voice event status %d", res.StatusCode)
	}
	return nil
}
