// raya_change - Actual loopback Pion negotiation/data-channel readiness, no device audio.
package livekit

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func readinessPair(t *testing.T) (*track, *webrtc.PeerConnection, *webrtc.PeerConnection) {
	t.Helper()
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	first, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		_ = first.Close()
		t.Fatal(err)
	}
	// Pion closes undeclared incoming channels by default. This synthetic
	// receiver explicitly accepts them, as the production SDK does.
	second.OnDataChannel(func(channel *webrtc.DataChannel) {
		channel.OnMessage(func(webrtc.DataChannelMessage) {
			t.Error("readiness fixture unexpectedly transmitted application data")
		})
	})
	track, err := newTrack()
	if err != nil {
		_ = first.Close()
		_ = second.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ended := make(chan error, 1)
		go func() { ended <- errors.Join(track.Close(), first.GracefulClose(), second.GracefulClose()) }()
		select {
		case err := <-ended:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(2 * time.Second):
			t.Error("Pion readiness fixture cleanup retained an owner")
		}
	})
	if _, err := first.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	if _, err := first.CreateDataChannel("_reliable", nil); err != nil {
		t.Fatal(err)
	}
	return track, first, second
}

func readinessConnect(t *testing.T, first, second *webrtc.PeerConnection) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	offer, err := first.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(first)
	if err := first.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("actual loopback offer did not gather")
	}
	if err := second.SetRemoteDescription(*first.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := second.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(second)
	if err := second.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		t.Fatal("actual loopback answer did not gather")
	}
	if err := first.SetRemoteDescription(*second.LocalDescription()); err != nil {
		t.Fatal(err)
	}
}

func TestReadinessWaitsForActualBindingAndBothPublicChannelStates(t *testing.T) {
	track, first, second := readinessPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := readiness(ctx, track, first, func() bool { return false })
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || track.IsBound() {
		t.Fatal("unnegotiated publisher was reported ready", err)
	}
	readinessConnect(t, first, second)
	ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
	err = readiness(ctx, track, first, func() bool { return false })
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("publisher without lossy channel was reported ready", err)
	}
	if _, err := first.CreateDataChannel("_lossy", nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 3*time.Second)
	err = readiness(ctx, track, first, func() bool { return false })
	cancel()
	if err != nil || !track.IsBound() || first.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Log("actual states", first.ConnectionState(), second.ConnectionState(), track.IsBound(), first.SCTP().State())
		for _, raw := range first.GetStats() {
			if stats, ok := raw.(webrtc.DataChannelStats); ok {
				t.Log("actual channel", stats.Label, stats.State)
			}
		}
		t.Fatal("actual bound publisher/data channels did not become ready", err)
	}
	var abandoned atomic.Bool
	abandoned.Store(true)
	if err := readiness(context.Background(), track, first, abandoned.Load); !errors.Is(err, context.Canceled) {
		t.Fatal("late ready observation revived abandoned setup", err)
	}
	if err := track.Close(); err != nil {
		t.Fatal(err)
	}
	if err := readiness(context.Background(), track, first, func() bool { return false }); err == nil {
		t.Fatal("closed source binding was reported ready")
	}
}

func TestReadinessCancelledOrUnavailableSourceCannotActivate(t *testing.T) {
	track, first, _ := readinessPair(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := readiness(ctx, track, first, func() bool { return false }); !errors.Is(err, context.Canceled) {
		t.Fatal("pre-cancelled setup was observed ready", err)
	}
	if err := readiness(context.Background(), track, nil, func() bool { return false }); err == nil {
		t.Fatal("missing publisher was reported ready")
	}
}
