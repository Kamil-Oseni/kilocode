// raya_change - Public Pion readiness evidence before native transport activation.
package livekit

import (
	"context"
	"errors"
	"time"

	"github.com/pion/webrtc/v4"
)

// The caller retains setup ownership if a public SDK/Pion observation blocks.
// This barrier sends no dummy media/data and installs no SDK callbacks.
func readiness(ctx context.Context, track *track, peer *webrtc.PeerConnection, sealed func() bool) error {
	if track == nil || peer == nil || sealed == nil {
		return errors.New("voice publisher readiness source is unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if sealed() {
			return context.Canceled
		}
		if track.closed.Load() {
			return errors.New("voice publisher track closed during setup")
		}
		state := peer.ConnectionState()
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			return errors.New("voice publisher peer failed during setup")
		}
		if state == webrtc.PeerConnectionStateConnected && track.IsBound() {
			reliable, lossy := false, false
			r, l := 0, 0
			for _, raw := range peer.GetStats() {
				stats, ok := raw.(webrtc.DataChannelStats)
				if !ok {
					continue
				}
				switch stats.Label {
				case "_reliable":
					r++
					reliable = stats.State == webrtc.DataChannelStateOpen
				case "_lossy":
					l++
					lossy = stats.State == webrtc.DataChannelStateOpen
				}
			}
			// Recheck cancellation/ownership after the public observation. An expired
			// observation must never revive a cancelled setup or a retired binding.
			if err := ctx.Err(); err != nil {
				return err
			}
			if sealed() {
				return context.Canceled
			}
			if r == 1 && l == 1 && reliable && lossy && track.IsBound() && peer.ConnectionState() == webrtc.PeerConnectionStateConnected {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}
