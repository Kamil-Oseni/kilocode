// raya_change - managed callback destinations fail before voice or room allocation
package app

import (
	"context"
	"testing"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

func TestLocalDestination(t *testing.T) {
	allowed := map[string]string{
		"http://127.0.0.1:4096/": "http://127.0.0.1:4096",
		"http://[::1]:4096":      "http://[::1]:4096",
	}
	for input, expected := range allowed {
		actual, err := local(input)
		if err != nil || actual != expected {
			t.Fatalf("normalize %q: got %q, %v", input, actual, err)
		}
	}
	for _, input := range []string{
		"https://127.0.0.1:4096",
		"http://localhost:4096",
		"http://127.evil.example:4096",
		"http://192.168.1.2:4096",
		"http://user:secret@127.0.0.1:4096",
		"http://127.0.0.1:4096/path",
		"http://127.0.0.1:4096?next=remote",
		"http://127.0.0.1:99999",
	} {
		if _, err := local(input); err == nil {
			t.Fatalf("expected %q to be rejected", input)
		}
		manager := NewManager(nil)
		if _, err := manager.Start(context.Background(), wire.Start{BackendURL: input}); err == nil {
			t.Fatalf("manager accepted %q", input)
		}
		if len(manager.sessions) != 0 {
			t.Fatalf("invalid destination %q reserved a session", input)
		}
	}
}
