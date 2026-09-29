// raya_change - Real primary-WebSocket append lifecycle boundaries.
package live

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
)

func TestLiveLifecycleSupersessionAndSnapshotProjection(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	first := engine.ContextItem{ID: "private_balance", Kind: "fact", Text: "Balance is 10 dollars."}
	if err := value.Inject(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	old := written(t, f, "session.thinking.append")
	observed(t, value, "context.injected")
	second := engine.ContextItem{ID: "private_correction", Kind: "fact", Text: "Balance is 20 dollars.", Replaces: []string{first.ID}}
	if err := value.Inject(context.Background(), second); err != nil {
		t.Fatal(err)
	}
	update := written(t, f, "session.thinking.append")
	observed(t, value, "context.injected")
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || snapshot.Version != 1 || len(snapshot.Context) != 2 {
		t.Fatal("missing full projection snapshot", err)
	}
	if old["content"] != snapshot.Context[0].Content || update["content"] != snapshot.Context[1].Content || !strings.Contains(update["content"].(string), snapshot.Context[0].Label) || !strings.Contains(update["content"].(string), "replaces") {
		t.Fatal("correction did not preserve/address original provider content")
	}
	if strings.Contains(old["content"].(string), first.ID) || strings.Contains(update["content"].(string), second.ID) || len(update) != 4 {
		t.Fatal("private IDs or invented wire fields leaked")
	}
	second.Replaces[0] = "mutated"
	snapshot.Items[1].Replaces[0] = "mutated"
	snapshot.Context[1].Item.Replaces[0] = "mutated"
	retained, err := value.Snapshot(context.Background())
	if err != nil || retained.Items[1].Replaces[0] != first.ID || retained.Context[1].Item.Replaces[0] != first.ID {
		t.Fatal("snapshot/caller mutation changed retained supersession")
	}
	third := engine.ContextItem{ID: "legacy_correction", Kind: "fact", Text: "Balance is 30 dollars.", Supersedes: retained.Items[1].ID}
	if err := value.Inject(context.Background(), third); err != nil {
		t.Fatal("legacy singular supersession refused", err)
	}
	written(t, f, "session.thinking.append")
	observed(t, value, "context.injected")
	for _, item := range []engine.ContextItem{
		{ID: "mixed", Kind: "fact", Text: "Changed", Supersedes: first.ID, Replaces: []string{first.ID}},
		{ID: "duplicate", Kind: "fact", Text: "Changed", Replaces: []string{first.ID, first.ID}},
		{ID: "unknown", Kind: "fact", Text: "Changed", Replaces: []string{"unknown_prior"}},
		{ID: "self", Kind: "fact", Text: "Changed", Replaces: []string{"self"}},
	} {
		if value.Inject(context.Background(), item) == nil {
			t.Fatal("invalid relationship accepted", item.ID)
		}
	}
	select {
	case extra := <-f.writes:
		t.Fatal("rejected supersession had a wire effect", extra)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestLiveLifecycleAcceptedExpiryAndFaithfulPrefill(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "temporary_private", Kind: "fact", Text: "The current price is 12 dollars.", Created: time.Now(), TTLMS: 80}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	old := written(t, f, "session.thinking.append")
	observed(t, value, "context.injected")
	update := written(t, f, "session.thinking.append")
	observed(t, value, "context.injected")
	observed(t, value, "context.expired")
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || len(snapshot.Context) != 2 || snapshot.Context[1].Expired != item.ID || snapshot.Context[0].Content != old["content"] || snapshot.Context[1].Content != update["content"] || !snapshot.Items[1].Created.Equal(item.Created.Add(80*time.Millisecond)) {
		t.Fatal("expiry erased history or changed absolute deadline", err)
	}
	g := serve(t, nil)
	target, _ := opened(t, g)
	written(t, g, "session.start")
	if err := target.Prefill(context.Background(), snapshot); err != nil {
		t.Fatal("confirmed historical invalidation prefill refused", err)
	}
	for _, record := range snapshot.Context {
		if written(t, g, "session.thinking.append")["content"] != record.Content {
			t.Fatal("prefill rewrote provider prefix")
		}
		observed(t, target, "context.injected")
	}
	select {
	case extra := <-g.writes:
		t.Fatal("historical invalidation restarted expiry/replayed", extra)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestLiveLifecycleUnknownInvalidationFencesWithoutReplay(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		content, _ := value["content"].(string)
		if strings.Contains(content, "has expired") {
			return map[string]any{"type": "error", "error": map[string]any{"client_event_id": value["event_id"]}}
		}
		return answer
	})
	value, _ := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "expires_unknown", Kind: "fact", Text: "Temporary", Created: time.Now(), TTLMS: 50}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	written(t, f, "session.thinking.append")
	written(t, f, "session.thinking.append")
	written(t, f, "session.close")
	if err := value.Close(); err != nil {
		t.Fatal("local provider cleanup failed", err)
	}
	if value.Inject(context.Background(), engine.ContextItem{ID: "after_expiry", Kind: "fact", Text: "New"}) == nil {
		t.Fatal("unknown invalidation permitted new work/context")
	}
	if _, err := value.Snapshot(context.Background()); err == nil {
		t.Fatal("unknown invalidation became replayable checkpoint")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("unknown invalidation replayed", extra)
	case <-time.After(30 * time.Millisecond):
	}
	select {
	case <-value.(*session).lifecycle:
	default:
		t.Fatal("expiry owner was not joined")
	}
}

func TestLiveLifecycleSnapshotValidationHasNoPartialEffect(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	now := time.Now()
	for _, snapshot := range []engine.Snapshot{
		{Items: []engine.ContextItem{{ID: "first", Kind: "fact", Text: "Good", Created: now}, {ID: "bad", Kind: "fact", Text: string([]byte{0xff}), Created: now}}},
		{Items: []engine.ContextItem{{ID: "first", Kind: "fact", Text: "Good", Created: now}, {ID: "first", Kind: "fact", Text: "Good", Created: now}}},
		{Version: 2},
		{Items: []engine.ContextItem{{ID: "ttl", Kind: "fact", Text: "Good", Created: now, TTLMS: 10}}},
	} {
		if value.Prefill(context.Background(), snapshot) == nil {
			t.Fatal("invalid whole snapshot accepted")
		}
	}
	select {
	case extra := <-f.writes:
		t.Fatal("prefill validation allowed partial effect", extra)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestLiveLifecycleRichSnapshotTamperHasNoPartialEffect(t *testing.T) {
	f := serve(t, nil)
	source, _ := opened(t, f)
	written(t, f, "session.start")
	for _, id := range []string{"first_fact", "second_fact"} {
		if err := source.Inject(context.Background(), engine.ContextItem{ID: id, Kind: "fact", Text: "Accepted"}); err != nil {
			t.Fatal(err)
		}
		written(t, f, "session.thinking.append")
		observed(t, source, "context.injected")
	}
	snapshot, err := source.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g := serve(t, nil)
	target, _ := opened(t, g)
	written(t, g, "session.start")
	snapshot.Context[1].Content = "forged"
	if target.Prefill(context.Background(), snapshot) == nil {
		t.Fatal("altered full-record projection accepted")
	}
	snapshot.Context[1].Content = projection(snapshot.Context[1].Item, snapshot.Context[1].Label, nil, "")
	snapshot.Context[1].Item.Kind = "invalid kind"
	snapshot.Items[1].Kind = "invalid kind"
	if target.Prefill(context.Background(), snapshot) == nil {
		t.Fatal("late invalid kind allowed earlier prefill effect")
	}
	select {
	case extra := <-g.writes:
		t.Fatal("rich validation permitted a partial effect", extra)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestLiveLifecycleSharedExpiryOwnerHandlesSameDeadline(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	created := time.Now()
	for _, id := range []string{"expiry_one", "expiry_two"} {
		if err := value.Inject(context.Background(), engine.ContextItem{ID: id, Kind: "fact", Text: "Temporary", Created: created, TTLMS: 100}); err != nil {
			t.Fatal(err)
		}
		written(t, f, "session.thinking.append")
		observed(t, value, "context.injected")
	}
	for index := 0; index < 2; index++ {
		written(t, f, "session.thinking.append")
		observed(t, value, "context.injected")
		observed(t, value, "context.expired")
	}
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || len(snapshot.Context) != 4 {
		t.Fatal("shared deadline lost an invalidation", err)
	}
	if !snapshot.Items[2].Created.Equal(created.Add(100*time.Millisecond)) || !snapshot.Items[3].Created.Equal(created.Add(100*time.Millisecond)) {
		t.Fatal("serialization extended original expiry")
	}
	if err := value.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-value.(*session).lifecycle:
	default:
		t.Fatal("shared scheduler survived close")
	}
}

func TestLiveLifecycleCommentaryKeepsDeliverySemantics(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "commentary_private", Kind: "commentary", Text: "Your task response is ready.", Created: time.Now(), TTLMS: 50}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	if written(t, f, "session.commentary.append")["content"] != item.Text {
		t.Fatal("public labels became spoken commentary")
	}
	observed(t, value, "context.injected")
	time.Sleep(80 * time.Millisecond)
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || len(snapshot.Items) != 1 || snapshot.Context[0].Label != "" {
		t.Fatal("delivery TTL retracted task commentary", err)
	}
	select {
	case extra := <-f.writes:
		t.Fatal("delivery TTL generated factual invalidation", extra)
	case <-time.After(20 * time.Millisecond):
	}
}

func TestLiveLifecycleLostInvalidationAckStopJoinsOwner(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		content, _ := value["content"].(string)
		if strings.Contains(content, "has expired") {
			return nil
		}
		return answer
	})
	value, _ := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "lost_expiry", Kind: "fact", Text: "Temporary", Created: time.Now(), TTLMS: 50}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	written(t, f, "session.thinking.append")
	written(t, f, "session.thinking.append")
	if err := value.Close(); err != nil {
		t.Fatal(err)
	}
	written(t, f, "session.close")
	select {
	case <-value.(*session).lifecycle:
	default:
		t.Fatal("Stop returned without joined expiry owner")
	}
	if _, err := value.Snapshot(context.Background()); err == nil {
		t.Fatal("lost expiry ACK became accepted")
	}
}

func TestLiveLifecycleExpiryCapacityIsReservedBeforeWire(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	for index := 0; index < 128; index++ {
		item := engine.ContextItem{ID: fmt.Sprintf("reserved_%d", index), Kind: "fact", Text: "Temporary", Created: time.Now(), TTLMS: 60000}
		if err := value.Inject(context.Background(), item); err != nil {
			t.Fatal(index, err)
		}
		written(t, f, "session.thinking.append")
		observed(t, value, "context.injected")
	}
	if value.Inject(context.Background(), engine.ContextItem{ID: "overflow", Kind: "fact", Text: "One more"}) == nil {
		t.Fatal("admission consumed an expiry reservation")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("capacity refusal had a wire effect", extra)
	case <-time.After(20 * time.Millisecond):
	}
	if err := value.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-value.(*session).lifecycle:
	default:
		t.Fatal("reserved timers outlived Stop")
	}
}

func TestLiveLifecycleExpiryFencesLocalIngressUntilExactAck(t *testing.T) {
	f := serve(t, func(value, answer map[string]any) map[string]any {
		content, _ := value["content"].(string)
		if strings.Contains(content, "has expired") {
			return nil
		}
		return answer
	})
	value, conn := opened(t, f)
	written(t, f, "session.start")
	item := engine.ContextItem{ID: "local_fence", Kind: "fact", Text: "Temporary", Created: time.Now(), TTLMS: 80}
	if err := value.Inject(context.Background(), item); err != nil {
		t.Fatal(err)
	}
	written(t, f, "session.thinking.append")
	observed(t, value, "context.injected")
	prior := *value.(*session).source.Load()
	update := written(t, f, "session.thinking.append")
	pcm := make([]byte, 960)
	for index := range pcm {
		pcm[index] = 1
	}
	if err := send(conn, map[string]any{"type": "session.output_audio.delta", "delta": base64.StdEncoding.EncodeToString(pcm)}); err != nil {
		t.Fatal(err)
	}
	end := time.Now().Add(time.Second)
	for value.Stats().DroppedBytes < 960 && time.Now().Before(end) {
		time.Sleep(time.Millisecond)
	}
	if value.Stats().DroppedBytes < 960 || !value.(*session).paused.Load() {
		t.Fatal("during-fence provider bytes entered local playout")
	}
	if err := send(conn, map[string]any{"type": "session.thinking.appended", "event_id": "expiry_accepted", "client_event_id": update["event_id"], "start_ms": 0, "end_ms": 20}); err != nil {
		t.Fatal(err)
	}
	observed(t, value, "context.injected")
	observed(t, value, "context.expired")
	current := *value.(*session).source.Load()
	if prior == current || value.(*session).paused.Load() {
		t.Fatal("exact ACK did not advance local ingress generation")
	}
	if err := send(conn, map[string]any{"type": "session.output_audio.delta", "delta": base64.StdEncoding.EncodeToString(pcm)}); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		select {
		case frame := <-value.Audio():
			if frame.Item == current && len(frame.PCM) == 960 && frame.PCM[0] == 1 {
				return
			}
			if frame.Item == prior && len(frame.PCM) != 0 && frame.PCM[0] == 1 {
				t.Fatal("old local ingress survived fence")
			}
		case <-deadline.C:
			t.Fatal("post-ACK local ingress did not resume")
			return
		}
	}
}

func TestLiveLifecyclePrefillOwnsEntirePrefixAdmission(t *testing.T) {
	f := serve(t, nil)
	source, _ := opened(t, f)
	written(t, f, "session.start")
	for _, text := range []string{"First fact", "Second fact"} {
		if err := source.Inject(context.Background(), engine.ContextItem{ID: strings.ReplaceAll(text, " ", "_"), Kind: "fact", Text: text}); err != nil {
			t.Fatal(err)
		}
		written(t, f, "session.thinking.append")
		observed(t, source, "context.injected")
	}
	snapshot, err := source.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g := serve(t, func(value, answer map[string]any) map[string]any {
		content, _ := value["content"].(string)
		if strings.Contains(content, "First fact") {
			return nil
		}
		return answer
	})
	target, conn := opened(t, g)
	written(t, g, "session.start")
	done := make(chan error, 1)
	go func() { done <- target.Prefill(context.Background(), snapshot) }()
	first := written(t, g, "session.thinking.append")
	if target.Inject(context.Background(), engine.ContextItem{ID: "interleaved", Kind: "fact", Text: "Unrelated"}) == nil {
		t.Fatal("concurrent admission interleaved the prefix")
	}
	if target.Prefill(context.Background(), snapshot) == nil {
		t.Fatal("second prefill owner was admitted")
	}
	if err := send(conn, map[string]any{"type": "session.thinking.appended", "event_id": "prefix_accepted", "client_event_id": first["event_id"], "start_ms": 0, "end_ms": 20}); err != nil {
		t.Fatal(err)
	}
	second := written(t, g, "session.thinking.append")
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("owned prefix did not finish")
	}
	if first["content"] != snapshot.Context[0].Content || second["content"] != snapshot.Context[1].Content {
		t.Fatal("concurrent admission changed prefix ordering")
	}
	if err := target.Inject(context.Background(), engine.ContextItem{ID: "after_prefix", Kind: "fact", Text: "Allowed"}); err != nil {
		t.Fatal("prefill admission fence was not released", err)
	}
	written(t, g, "session.thinking.append")
}

func TestLiveLifecyclePartialHistoricalPrefillCancellationFences(t *testing.T) {
	f := serve(t, nil)
	source, _ := opened(t, f)
	written(t, f, "session.start")
	if err := source.Inject(context.Background(), engine.ContextItem{ID: "old_historical", Kind: "fact", Text: "Expired original", Created: time.Now(), TTLMS: 50}); err != nil {
		t.Fatal(err)
	}
	written(t, f, "session.thinking.append")
	observed(t, source, "context.injected")
	written(t, f, "session.thinking.append")
	observed(t, source, "context.injected")
	observed(t, source, "context.expired")
	snapshot, err := source.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g := serve(t, func(value, answer map[string]any) map[string]any {
		content, _ := value["content"].(string)
		if strings.Contains(content, "has expired") {
			return nil
		}
		return answer
	})
	target, conn := opened(t, g)
	written(t, g, "session.start")
	prior := *target.(*session).source.Load()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- target.Prefill(ctx, snapshot) }()
	written(t, g, "session.thinking.append")
	observed(t, target, "context.injected")
	written(t, g, "session.thinking.append")
	pcm := make([]byte, 960)
	for index := range pcm {
		pcm[index] = 1
	}
	if err := send(conn, map[string]any{"type": "session.output_audio.delta", "delta": base64.StdEncoding.EncodeToString(pcm)}); err != nil {
		t.Fatal(err)
	}
	end := time.Now().Add(time.Second)
	for target.Stats().DroppedBytes < 960 && time.Now().Before(end) {
		time.Sleep(time.Millisecond)
	}
	if target.Stats().DroppedBytes < 960 || !target.(*session).paused.Load() || *target.(*session).source.Load() != prior {
		t.Fatal("held historical invalidation scheduled audio or resumed ingress")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("partial expired prefix became successful")
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled prefill did not return")
	}
	written(t, g, "session.close")
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
	if target.Inject(context.Background(), engine.ContextItem{ID: "unsafe_new", Kind: "fact", Text: "Continue"}) == nil {
		t.Fatal("partial expired prefix retained live authority")
	}
	if target.PushAudio(context.Background(), make([]byte, 960)) == nil {
		t.Fatal("partial expired prefix allowed fresh input")
	}
	if target.Prefill(context.Background(), snapshot) == nil {
		t.Fatal("partial prefix automatically became replayable")
	}
	if !target.(*session).paused.Load() || *target.(*session).source.Load() != prior {
		t.Fatal("failed historical restoration resumed local ingress")
	}
	select {
	case extra := <-g.writes:
		t.Fatal("partial invalidation replayed", extra)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestLiveLifecycleExpiryDuringHeldPrefixNeverResumesEarly(t *testing.T) {
	f := serve(t, nil)
	source, _ := opened(t, f)
	written(t, f, "session.start")
	created := time.Now()
	for _, item := range []engine.ContextItem{
		{ID: "prefix_ttl", Kind: "fact", Text: "Temporary first", Created: created, TTLMS: 200},
		{ID: "prefix_later", Kind: "fact", Text: "Held later", Created: created},
	} {
		if err := source.Inject(context.Background(), item); err != nil {
			t.Fatal(err)
		}
		written(t, f, "session.thinking.append")
		observed(t, source, "context.injected")
	}
	snapshot, err := source.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g := serve(t, func(value, answer map[string]any) map[string]any {
		content, _ := value["content"].(string)
		if strings.Contains(content, "Held later") || strings.Contains(content, "has expired") {
			return nil
		}
		return answer
	})
	target, conn := opened(t, g)
	written(t, g, "session.start")
	prior := *target.(*session).source.Load()
	done := make(chan error, 1)
	go func() { done <- target.Prefill(context.Background(), snapshot) }()
	written(t, g, "session.thinking.append")
	observed(t, target, "context.injected")
	later := written(t, g, "session.thinking.append")
	if wait := time.Until(created.Add(220 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}
	if err := send(conn, map[string]any{"type": "session.thinking.appended", "event_id": "later_prefix_accepted", "client_event_id": later["event_id"], "start_ms": 0, "end_ms": 20}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("held prefix did not finish")
	}
	observed(t, target, "context.injected")
	invalidation := written(t, g, "session.thinking.append")
	if !target.(*session).paused.Load() || *target.(*session).source.Load() != prior {
		t.Fatal("prefix resumed before due expiry was acknowledged")
	}
	pcm := make([]byte, 960)
	for index := range pcm {
		pcm[index] = 1
	}
	if err := send(conn, map[string]any{"type": "session.output_audio.delta", "delta": base64.StdEncoding.EncodeToString(pcm)}); err != nil {
		t.Fatal(err)
	}
	end := time.Now().Add(time.Second)
	for target.Stats().DroppedBytes < 960 && time.Now().Before(end) {
		time.Sleep(time.Millisecond)
	}
	if target.Stats().DroppedBytes < 960 {
		t.Fatal("expired prefix scheduled intermediate local audio")
	}
	if err := send(conn, map[string]any{"type": "session.thinking.appended", "event_id": "due_prefix_expiry_accepted", "client_event_id": invalidation["event_id"], "start_ms": 0, "end_ms": 20}); err != nil {
		t.Fatal(err)
	}
	observed(t, target, "context.injected")
	observed(t, target, "context.expired")
	if target.(*session).paused.Load() || *target.(*session).source.Load() == prior {
		t.Fatal("exact due expiry ACK did not release local fence")
	}
}

func TestLiveLifecycleAttemptedNonTTLReplacementUnknownFences(t *testing.T) {
	for _, mode := range []string{"lost_plural", "refused_plural", "lost_singular", "refused_singular"} {
		t.Run(mode, func(t *testing.T) {
			f := serve(t, func(value, answer map[string]any) map[string]any {
				content, _ := value["content"].(string)
				if strings.Contains(content, " replaces ") {
					if strings.HasPrefix(mode, "lost_") {
						return nil
					}
					return map[string]any{"type": "error", "error": map[string]any{"client_event_id": value["event_id"]}}
				}
				return answer
			})
			value, _ := opened(t, f)
			written(t, f, "session.start")
			if err := value.Inject(context.Background(), engine.ContextItem{ID: "old_value", Kind: "fact", Text: "Old value"}); err != nil {
				t.Fatal(err)
			}
			written(t, f, "session.thinking.append")
			observed(t, value, "context.injected")
			item := engine.ContextItem{ID: "new_value", Kind: "fact", Text: "Correct value", Replaces: []string{"old_value"}}
			if strings.HasSuffix(mode, "_singular") {
				item.Replaces = nil
				item.Supersedes = "old_value"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			defer cancel()
			if value.Inject(ctx, item) == nil {
				t.Fatal("unknown replacement became confirmed")
			}
			written(t, f, "session.thinking.append")
			written(t, f, "session.close")
			if value.PushAudio(context.Background(), make([]byte, 960)) == nil {
				t.Fatal("unconfirmed non-TTL replacement permitted fresh input")
			}
			if err := value.Close(); err != nil {
				t.Fatal(err)
			}
			if value.Inject(context.Background(), item) == nil {
				t.Fatal("uncertain replacement replay became accepted")
			}
			if _, err := value.Snapshot(context.Background()); err == nil {
				t.Fatal("uncertain replacement became a replayable snapshot")
			}
			select {
			case extra := <-f.writes:
				t.Fatal("replacement was retried", extra)
			case <-time.After(20 * time.Millisecond):
			}
		})
	}
}

func TestLiveLifecycleSnapshotTracksConcurrentActualWireOrder(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	const count = 16
	start := make(chan struct{})
	failures := make(chan error, count)
	var workers sync.WaitGroup
	for index := 0; index < count; index++ {
		workers.Add(1)
		go func(index int) {
			defer workers.Done()
			<-start
			failures <- value.Inject(context.Background(), engine.ContextItem{ID: fmt.Sprintf("concurrent_%d", index), Kind: "fact", Text: fmt.Sprintf("Value %d", index)})
		}(index)
	}
	close(start)
	contents := make([]string, 0, count)
	for index := 0; index < count; index++ {
		contents = append(contents, written(t, f, "session.thinking.append")["content"].(string))
	}
	workers.Wait()
	for index := 0; index < count; index++ {
		if err := <-failures; err != nil {
			t.Fatal(err)
		}
		observed(t, value, "context.injected")
	}
	snapshot, err := value.Snapshot(context.Background())
	if err != nil || len(snapshot.Context) != count {
		t.Fatal("missing accepted concurrent prefix", err)
	}
	// Compare the observed boundary, never assume a particular goroutine order.
	for index, content := range contents {
		if snapshot.Context[index].Content != content {
			t.Fatal("snapshot reordered actual submitted provider prefix", index)
		}
	}
	g := serve(t, nil)
	target, _ := opened(t, g)
	written(t, g, "session.start")
	if err := target.Prefill(context.Background(), snapshot); err != nil {
		t.Fatal(err)
	}
	for _, content := range contents {
		if written(t, g, "session.thinking.append")["content"] != content {
			t.Fatal("prefill reordered the actual provider prefix")
		}
		observed(t, target, "context.injected")
	}
}

func TestLiveLifecyclePreGateRefusalStillBlocksSnapshot(t *testing.T) {
	f := serve(t, nil)
	value, _ := opened(t, f)
	written(t, f, "session.start")
	s := value.(*session)
	<-s.gate
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := value.Inject(ctx, engine.ContextItem{ID: "never_written", Kind: "fact", Text: "Unconfirmed"})
	cancel()
	s.gate <- struct{}{}
	if err == nil {
		t.Fatal("held gate was treated as successful append")
	}
	if _, err := value.Snapshot(context.Background()); err == nil {
		t.Fatal("unordered failed admission disappeared from snapshot validation")
	}
	select {
	case extra := <-f.writes:
		t.Fatal("pre-gate refusal wrote context", extra)
	case <-time.After(20 * time.Millisecond):
	}
}
