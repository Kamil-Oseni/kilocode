package process

import (
	"errors"
	"testing"
)

// Version 1 fixture opt-in. Empty keeps parent diagnostics unallocated.
func diagnostic(value string) (bool, error) {
	if value == "" {
		return false, nil
	}
	if value == "1" {
		return true, nil
	}
	return false, errors.New("parent action diagnostic gate must be exactly 1")
}

func TestResourceParentTraceValidation(t *testing.T) {
	for _, value := range []string{"", "1", "0", "true", "false", " 1", "1 ", "2", "\n"} {
		enabled, err := diagnostic(value)
		valid := value == "" || value == "1"
		if (err == nil) != valid || enabled != (value == "1") {
			t.Fatalf("strict diagnostic input changed: %q", value)
		}
	}
}
