// raya_change - Cross-plane TTL values are milliseconds, never Go duration nanoseconds.
package wire

import (
	"encoding/json"
	"testing"
)

func TestInjectionTTLUsesMilliseconds(t *testing.T) {
	var input Inject
	err := json.Unmarshal([]byte(`{"item":{"id":"delegate","kind":"delegation.result","text":"ready","ttl":5000,"created":"2026-08-26T00:00:00Z"}}`), &input)
	if err != nil {
		t.Fatal(err)
	}
	if input.Item.TTLMS != 5000 {
		t.Fatalf("ttl = %dms, want 5000ms", input.Item.TTLMS)
	}
}
