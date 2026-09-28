// kilocode_change - new file
package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

func TestBackendRedirect(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		for _, remote := range []bool{false, true} {
			t.Run(fmt.Sprintf("%d/other-port=%t", status, remote), func(t *testing.T) {
				var hits, received, redirects atomic.Int32
				target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					hits.Add(1)
					w.WriteHeader(http.StatusNoContent)
				}))
				defer target.Close()
				source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/redirected" {
						hits.Add(1)
						w.WriteHeader(http.StatusNoContent)
						return
					}
					received.Add(1)
					if r.Method != http.MethodPost || r.URL.Path != "/kilocode/voice/events" || r.Header.Get("Authorization") != "Basic synthetic-secret" || r.Header.Get("X-Raya-Voice-Capability") != "synthetic-voice-capability" || r.URL.Query().Get("directory") != "workspace with spaces" {
						t.Error("configured callback request lost its identity")
					}
					var event wire.Envelope
					if err := json.NewDecoder(r.Body).Decode(&event); err != nil || event.Session != "synthetic-session" || event.Seq != 7 {
						t.Error("configured callback request lost its event")
					}
					location := "/redirected"
					if remote {
						location = target.URL + location
					}
					w.Header().Set("Location", location)
					w.WriteHeader(status)
				}))
				defer source.Close()
				client := &http.Client{Timeout: time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
					redirects.Add(1)
					return nil
				}}
				backend := HTTPBackend{URL: source.URL, Auth: "Basic synthetic-secret", Control: "synthetic-voice-capability", Directory: "workspace with spaces", Client: client}
				err := backend.Event(context.Background(), wire.Envelope{Session: "synthetic-session", Seq: 7})
				if err == nil || err.Error() != fmt.Sprintf("voice event status %d", status) {
					t.Fatalf("expected status-only redirect refusal, got %v", err)
				}
				if received.Load() != 1 || hits.Load() != 0 || redirects.Load() != 0 {
					t.Fatalf("callback followed or replayed: source=%d destination=%d policy=%d", received.Load(), hits.Load(), redirects.Load())
				}
				// The injected client remains usable with its own policy after the callback.
				if err := client.CheckRedirect(nil, nil); err != nil || redirects.Load() != 1 {
					t.Fatal("callback mutated its caller's client")
				}
			})
		}
	}
}

func TestBackendDirect(t *testing.T) {
	var hits atomic.Int32
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer source.Close()
	if err := (HTTPBackend{URL: source.URL}).Event(context.Background(), wire.Envelope{Session: "direct"}); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 1 {
		t.Fatalf("expected one direct callback, got %d", hits.Load())
	}
}

func TestBackendReceiptAcknowledgement(t *testing.T) {
	for _, body := range []string{"true", " \ntrue\t", "false", "", "null", "{}", `"true"`, "true false", "true" + strings.Repeat(" ", 33)} {
		t.Run(fmt.Sprintf("body=%q", body), func(t *testing.T) {
			var hits atomic.Int32
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.Header.Get("X-Raya-Voice-Capability") != "synthetic-receipt-capability" {
					t.Error("receipt lost its private callback capability")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, body)
			}))
			defer source.Close()
			err := (HTTPBackend{URL: source.URL, Control: "synthetic-receipt-capability", Strict: true}).Event(context.Background(), wire.Envelope{Session: "setup"})
			valid := body == "true" || body == " \ntrue\t"
			if (err == nil) != valid || hits.Load() != 1 {
				t.Fatalf("receipt acknowledgement mismatch: valid=%t err=%v hits=%d", valid, err, hits.Load())
			}
		})
	}
	if err := (HTTPBackend{Strict: true}).Event(context.Background(), wire.Envelope{}); err == nil {
		t.Fatal("missing destination confirmed a receipt")
	}
	var hits atomic.Int32
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		fmt.Fprint(w, "true")
	}))
	defer source.Close()
	if err := (HTTPBackend{URL: source.URL, Strict: true}).Event(context.Background(), wire.Envelope{}); err == nil || hits.Load() != 0 {
		t.Fatal("receipt without a capability sent a callback")
	}
}
