package process

import (
	"errors"
	"testing"
)

func strategy(raw string) (string, error) {
	if raw == "" || raw == "churn" {
		return "churn", nil
	}
	if raw == "continuous" {
		return raw, nil
	}
	return "", errors.New("resource mode must be churn or continuous")
}

func TestResourceModeValidation(t *testing.T) {
	for _, value := range []struct{ raw, want string }{{"", "churn"}, {"churn", "churn"}, {"continuous", "continuous"}} {
		got, err := strategy(value.raw)
		if err != nil || got != value.want {
			t.Fatalf("mode %q resolved to %q: %v", value.raw, got, err)
		}
	}
	for _, value := range []string{"Continuous", " continuous", "churn ", "unknown", "0"} {
		if _, err := strategy(value); err == nil {
			t.Fatalf("invalid mode %q was accepted", value)
		}
	}
}
