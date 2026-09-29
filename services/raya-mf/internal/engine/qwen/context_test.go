package qwen

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/coder/websocket"
)

func TestContextLifecycleRefusesBeforeActualQwenWireEffects(t *testing.T) {
	messages := make(chan map[string]any, 16)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		for {
			_, body, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var message map[string]any
			if err := json.Unmarshal(body, &message); err != nil {
				t.Error(err)
				return
			}
			if message["type"] == "session.update" {
				if err := conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"session.updated","session":{"id":"ready"}}`)); err != nil {
					t.Error(err)
					return
				}
				continue
			}
			messages <- message
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	voice, err := (Engine{}).Open(ctx, engine.Config{Endpoint: strings.Replace(server.URL, "http://", "ws://", 1), Key: "loopback-only", Model: "test"})
	if err != nil {
		t.Fatal(err)
	}
	defer voice.Close()
	item := engine.ContextItem{ID: "fact", Kind: "fact", Text: "Legacy context", Created: time.Now()}
	for _, mode := range []string{"supersedes", "replaces", "version", "projection", "later_item", "ttl", "later_ttl"} {
		t.Run(mode, func(t *testing.T) {
			changed := item
			var err error
			switch mode {
			case "supersedes":
				changed.Supersedes = "prior"
				err = voice.Inject(ctx, changed)
			case "replaces":
				changed.Replaces = []string{"prior"}
				err = voice.Inject(ctx, changed)
			case "version":
				err = voice.Prefill(ctx, engine.Snapshot{Version: 1, Items: []engine.ContextItem{item}})
			case "projection":
				err = voice.Prefill(ctx, engine.Snapshot{Items: []engine.ContextItem{item}, Context: []engine.ContextRecord{{Item: item, Content: item.Text}}})
			case "later_item":
				changed.Replaces = []string{"prior"}
				err = voice.Prefill(ctx, engine.Snapshot{Items: []engine.ContextItem{item, changed}})
			case "ttl":
				changed.TTLMS = 5000
				err = voice.Inject(ctx, changed)
			case "later_ttl":
				changed.TTLMS = 5000
				err = voice.Prefill(ctx, engine.Snapshot{Items: []engine.ContextItem{item, changed}})
			}
			if err == nil {
				t.Fatal("unsupported context lifecycle was accepted")
			}
		})
	}
	// The accepted legacy append is the ordered socket barrier: no rejected
	// operation, including a later invalid prefill item, may precede it.
	if err := voice.Inject(ctx, item); err != nil {
		t.Fatal(err)
	}
	select {
	case message := <-messages:
		body, _ := json.Marshal(message)
		if message["type"] != "conversation.item.create" || !strings.Contains(string(body), `"id":"fact"`) || !strings.Contains(string(body), "Legacy context") {
			t.Fatal("rejected lifecycle emitted a wire effect before accepted legacy context")
		}
	case <-ctx.Done():
		t.Fatal("accepted legacy context did not reach actual socket")
	}
	snapshot, err := voice.Snapshot(ctx)
	if err != nil || snapshot.Version != 0 || len(snapshot.Items) != 1 {
		t.Fatal("legacy snapshot changed", err)
	}
	snapshot.Items[0].Text = "caller mutation"
	again, err := voice.Snapshot(ctx)
	if err != nil || again.Items[0].Text != item.Text {
		t.Fatal("caller snapshot mutation changed retained context", err)
	}
	for _, kind := range []string{"commentary", "call"} {
		delivery := engine.ContextItem{ID: kind, Kind: "commentary", Text: "Delivery only", TTLMS: 5000, Created: time.Now()}
		if kind == "call" {
			delivery.Kind = "guidance"
			delivery.Call = "existing-call"
		}
		if err := voice.Inject(ctx, delivery); err != nil {
			t.Fatal("supported delivery deadline was refused", err)
		}
		select {
		case message := <-messages:
			payload := message["item"].(map[string]any)
			if message["type"] != "conversation.item.create" || payload["id"] != kind {
				t.Fatal("delivery deadline changed actual wire effect")
			}
		case <-ctx.Done():
			t.Fatal("supported delivery did not reach actual socket")
		}
	}
	select {
	case <-messages:
		t.Fatal("unsupported context emitted extra wire effect")
	default:
	}
}
