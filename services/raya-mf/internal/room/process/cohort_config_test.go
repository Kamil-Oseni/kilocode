package process

import (
	"errors"
	"strconv"
	"testing"
)

func cohortConfig(workers, duration string) (int, bool, error) {
	if workers == "" {
		return 0, false, nil
	}
	if workers != "8" {
		return 0, false, errors.New("cohort resource workers must be exactly 8")
	}
	if duration != "60" && duration != "1800" {
		return 0, false, errors.New("cohort resource seconds must be 60 or 1800")
	}
	seconds, _ := strconv.Atoi(duration)
	return seconds, true, nil
}

func TestCohortResourceConfiguration(t *testing.T) {
	if _, enabled, err := cohortConfig("", "invalid"); err != nil || enabled {
		t.Fatal("absent explicit cohort gate enabled measurement")
	}
	for _, duration := range []string{"60", "1800"} {
		seconds, enabled, err := cohortConfig("8", duration)
		if err != nil || !enabled || strconv.Itoa(seconds) != duration {
			t.Fatal("valid cohort configuration refused")
		}
	}
	for _, raw := range [][2]string{{"1", "60"}, {"08", "60"}, {"8 ", "60"}, {"9", "60"}, {"8", ""}, {"8", "59"}, {"8", "1801"}, {"8", "60.0"}, {"8", " 60"}, {"8", "+60"}} {
		if _, _, err := cohortConfig(raw[0], raw[1]); err == nil {
			t.Fatal("invalid cohort configuration accepted", raw)
		}
	}
}
