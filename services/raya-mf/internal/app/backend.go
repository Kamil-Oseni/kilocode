// raya_change - Deadline-bounded async-plane event transport; audio never crosses this boundary.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	Control   string
	Directory string
	Client    *http.Client
	Strict    bool
}

func (b HTTPBackend) Event(ctx context.Context, event wire.Envelope) error {
	if b.URL == "" {
		if b.Strict {
			return fmt.Errorf("voice receipt has no configured backend")
		}
		return nil
	}
	if b.Strict && b.Control == "" {
		return fmt.Errorf("voice receipt has no callback capability")
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
	if b.Control != "" {
		req.Header.Set("X-Raya-Voice-Capability", b.Control)
	}
	client := b.Client
	if client == nil {
		client = &http.Client{Timeout: 150 * time.Millisecond}
	}
	// kilocode_change start - callback credentials and event bodies stay at the configured destination
	// Copy the client so a shared caller's redirect policy is not mutated.
	local := *client
	local.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	res, err := local.Do(req)
	// kilocode_change end
	if err != nil {
		return fmt.Errorf("send voice event: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= http.StatusMultipleChoices {
		return fmt.Errorf("voice event status %d", res.StatusCode)
	}
	if b.Strict {
		body, err := io.ReadAll(io.LimitReader(res.Body, 33))
		if err != nil || len(body) > 32 || string(bytes.TrimSpace(body)) != "true" {
			return fmt.Errorf("voice receipt acceptance is unconfirmed")
		}
	}
	return nil
}
