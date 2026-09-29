//go:build cgo && !windows

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

type latency struct {
	Count int     `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	Max   float64 `json:"max"`
}

func distribution(samples []time.Duration) latency {
	values := append([]time.Duration(nil), samples...)
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	if len(values) == 0 {
		return latency{}
	}
	quantile := func(percent int) float64 {
		index := (len(values)*percent+99)/100 - 1
		return float64(values[index]) / float64(time.Millisecond)
	}
	return latency{Count: len(values), P50: quantile(50), P95: quantile(95), Max: quantile(100)}
}

// This is a bounded measurement of production process/SFU control boundaries.
// Observer setup is excluded from startup; arrival and ACK are independent
// observations from the same call start, neither proves audible playback.
func TestProductionWorkerActualSFULatencySamples(t *testing.T) {
	path, raw, key, secret := environment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	binary, err := os.ReadFile(path)
	if err != nil {
		t.Fatal("cannot fingerprint production binary", err)
	}
	hash := sha256.Sum256(binary)
	metrics := map[string][]time.Duration{}
	type attempts struct {
		Sessions int `json:"attemptedSessions"`
		Settled  int `json:"completedSessions"`
		Trials   int `json:"attemptedTrials"`
		Received int `json:"confirmedExactNonces"`
	}
	progress := attempts{}
	defer func() {
		summary := make(map[string]latency, len(metrics))
		samples := make(map[string][]float64, len(metrics))
		for name, values := range metrics {
			summary[name] = distribution(values)
			for _, value := range values {
				samples[name] = append(samples[name], float64(value)/float64(time.Millisecond))
			}
		}
		status := "complete"
		if t.Failed() || progress.Settled != 10 || progress.Received != 50 {
			status = "partial_or_failed"
		}
		body, err := json.Marshal(struct {
			Version    int                  `json:"version"`
			Status     string               `json:"status"`
			Unit       string               `json:"unit"`
			Provenance string               `json:"provenance"`
			Binary     string               `json:"binarySHA256"`
			Progress   attempts             `json:"progress"`
			Scope      string               `json:"scope"`
			Samples    map[string][]float64 `json:"samples"`
			Metrics    map[string]latency   `json:"metrics"`
		}{1, status, "milliseconds", "actual production executable child and loopback SFU with independent SDK client; repeated startup, OS page-cache state uncontrolled", hex.EncodeToString(hash[:]), progress, "process startup, confirmed control ACK, exact client nonce arrival, actual process Wait; excludes provider, microphone, PCM playback and UI; any refused or missing trial fails the test without retry", samples, summary})
		if err != nil {
			t.Error("latency summary serialization failed", err)
			return
		}
		t.Logf("RAYA_MEDIA_LATENCY %s", body)
	}()
	for index := 0; index < 10; index++ {
		progress.Sessions++
		func() {
			ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			id := fmt.Sprintf("rvs_latency_%d_%d", time.Now().UnixNano(), index)
			name, client, owner := "raya-"+id, "client-"+id, "media-"+id
			token := func(identity string) string {
				value, err := auth.NewAccessToken(key, secret).SetIdentity(identity).SetValidFor(3 * time.Minute).SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: name}).ToJWT()
				if err != nil {
					t.Fatal("test token creation failed", err)
				}
				return value
			}
			type arrival struct {
				body []byte
				at   time.Time
			}
			observed := make(chan arrival, 16)
			peer := lksdk.NewRoom(&lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
				value, ok := packet.(*lksdk.UserDataPacket)
				if !ok || params.SenderIdentity != owner || value.Topic != "raya.latency" {
					return
				}
				select {
				case observed <- arrival{body: bytes.Clone(value.Payload), at: time.Now()}:
				default:
				}
			}}})
			defer func() {
				done := make(chan struct{})
				go func() { peer.Disconnect(); close(done) }()
				select {
				case <-done:
				case <-time.After(4 * time.Second):
					t.Error("latency observer cleanup did not finish")
				}
			}()
			if err := peer.JoinWithContextAndToken(ctx, raw, token(client)); err != nil {
				t.Fatal("actual SFU observer join failed", err)
			}
			credential := token(owner)
			started := time.Now()
			joined, err := (Factory{Path: path}).JoinAudioAuthorized(ctx, raw, credential, name, client, 24000)
			if err != nil {
				t.Fatal("actual production child join failed", err)
			}
			metrics["join_ready"] = append(metrics["join_ready"], time.Since(started))
			proxy, ok := joined.(*Proxy)
			if !ok {
				t.Fatal("production Factory did not return process owner")
			}
			defer func() { _ = proxy.Close(); terminated(t, proxy) }()
			for call := 0; call < 5; call++ {
				progress.Trials++
				prefix := "warm"
				if call == 0 {
					prefix = "first"
				}
				nonce := []byte(fmt.Sprintf("nonce-%s-%d", id, call))
				started := time.Now()
				if err := proxy.Send(ctx, room.Data{Topic: "raya.latency", Body: nonce}); err != nil {
					t.Fatal("single-attempt actual Send was not confirmed", err)
				}
				metrics[prefix+"_send_ack"] = append(metrics[prefix+"_send_ack"], time.Since(started))
				select {
				case result := <-observed:
					if !bytes.Equal(result.body, nonce) {
						t.Fatal("independent client observed a duplicate or foreign nonce")
					}
					metrics[prefix+"_client_arrival"] = append(metrics[prefix+"_client_arrival"], result.at.Sub(started))
					progress.Received++
				case <-ctx.Done():
					t.Fatal("independent client nonce arrival deadline")
				}
			}
			started = time.Now()
			if err := proxy.Close(); err != nil && !errors.Is(err, room.ErrCleanupUnknown) {
				t.Fatal("production Close failed", err)
			}
			select {
			case <-proxy.Done():
			case <-time.After(4 * time.Second):
				t.Fatal("production child did not reach actual Wait")
			}
			metrics["close_actual_done"] = append(metrics["close_actual_done"], time.Since(started))
			terminated(t, proxy)
			progress.Settled++
		}()
	}
}
