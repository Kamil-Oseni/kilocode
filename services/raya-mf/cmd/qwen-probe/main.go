// raya_change - Opt-in key/model handshake probe; it sends no audio and does not run by default.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine/qwen"
)

func main() {
	key := os.Getenv("RAYA_QWEN_KEY")
	if key == "" {
		panic("RAYA_QWEN_KEY is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := (qwen.Engine{}).Open(ctx, engine.Config{
		Endpoint:  os.Getenv("RAYA_QWEN_ENDPOINT"),
		Key:       key,
		Model:     os.Getenv("RAYA_QWEN_MODEL"),
		Voice:     env("RAYA_QWEN_VOICE", "longanqian"),
		Mode:      "hands-free",
		Threshold: 0.1,
		Silence:   900 * time.Millisecond,
	})
	if err != nil {
		panic(err)
	}
	defer session.Close()
	for {
		select {
		case <-ctx.Done():
			panic("Qwen did not acknowledge the session before the probe deadline")
		case event := <-session.Events():
			if event.Type == "engine.error" {
				panic(event.Text)
			}
			if event.Type == "session.updated" {
				fmt.Println("Qwen realtime key/model handshake passed; no audio was sent.")
				return
			}
		}
	}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
