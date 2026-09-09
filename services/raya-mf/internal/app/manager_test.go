package app

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type opening struct {
	open func(context.Context) (engine.Session, error)
}

func (o opening) Descriptor() engine.Descriptor { return engine.Descriptor{} }
func (o opening) Open(ctx context.Context, _ engine.Config) (engine.Session, error) {
	return o.open(ctx)
}

type joining struct {
	join func(context.Context) (room.Room, error)
}

func (j joining) Join(ctx context.Context, _, _, _ string) (room.Room, error) { return j.join(ctx) }

type closing struct {
	*fakeEngine
	count atomic.Int32
	close func() error
}

func (c *closing) Close() error {
	c.count.Add(1)
	if c.close != nil {
		return c.close()
	}
	return nil
}
func result(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("operation did not settle")
		return nil
	}
}
func TestManagerClaimsBeforeAllocationAndRetainsLifetime(t *testing.T) {
	entered := make(chan context.Context, 1)
	release := make(chan struct{})
	voice := &closing{fakeEngine: newFakeEngine()}
	var allocations atomic.Int32
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	manager.engine = opening{open: func(ctx context.Context) (engine.Session, error) {
		allocations.Add(1)
		entered <- ctx
		<-release
		return voice, nil
	}}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), struct{}{}, "trace"))
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := manager.Start(ctx, wire.Start{ID: "same"}); done <- err }()
	lifetime := <-entered
	if lifetime.Value(struct{}{}) != "trace" {
		t.Fatal("setup lost request context values")
	}
	for range 20 {
		if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); err == nil {
			t.Fatal("duplicate admitted")
		}
	}
	if allocations.Load() != 1 {
		t.Fatal("duplicate allocated resources")
	}
	close(release)
	if err := result(t, done); err != nil {
		t.Fatal(err)
	}
	cancel()
	if lifetime.Err() != nil {
		t.Fatal("request cancellation stopped established engine")
	}
	if err := manager.Close("same"); err != nil {
		t.Fatal(err)
	}
	if lifetime.Err() == nil || voice.count.Load() != 1 {
		t.Fatal("explicit close did not cancel and release once")
	}
}
func TestManagerStopDuringSetupReleasesBeforeReplacement(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	closing := make(chan struct{})
	voice := &closingEngine{fakeEngine: newFakeEngine(), entered: closing, release: release}
	manager := NewManager(joining{join: func(ctx context.Context) (room.Room, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return voice, nil }}
	start := make(chan error, 1)
	stop := make(chan error, 1)
	go func() { _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); start <- err }()
	<-entered
	go func() { stop <- manager.Close("same") }()
	<-closing
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); err == nil {
		t.Fatal("replacement allocated during teardown")
	}
	close(release)
	if err := result(t, start); !errors.Is(err, context.Canceled) {
		t.Fatalf("start = %v", err)
	}
	if err := result(t, stop); err != nil {
		t.Fatal(err)
	}
	manager.rooms = joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }}
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return newFakeEngine(), nil }}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "other"}); err == nil {
		t.Fatal("start after shutdown admitted")
	}
}

type closingEngine struct {
	*fakeEngine
	entered chan struct{}
	release chan struct{}
	failure error
}

func (c *closingEngine) Close() error { close(c.entered); <-c.release; return c.failure }
func TestManagerFailedSetupCanRetryAfterSuccessfulCleanup(t *testing.T) {
	setup := errors.New("room failed")
	voice := &closing{fakeEngine: newFakeEngine()}
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return nil, setup }})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return voice, nil }}
	for range 2 {
		_, err := manager.Start(context.Background(), wire.Start{ID: "retry"})
		if !errors.Is(err, setup) {
			t.Fatalf("errors lost: %v", err)
		}
	}
	if voice.count.Load() != 2 {
		t.Fatal("setup leaked engine")
	}
}
func TestConcurrentSessionCloseRetainsError(t *testing.T) {
	failure := errors.New("engine close failed")
	voice := &closing{fakeEngine: newFakeEngine(), close: func() error { return failure }}
	session := NewSession(context.Background(), "close", voice, newFakeRoom(), nil)
	done := make(chan error, 20)
	for range 20 {
		go func() { done <- session.Close() }()
	}
	for range 20 {
		if err := result(t, done); !errors.Is(err, failure) {
			t.Fatalf("close error lost: %v", err)
		}
	}
	if voice.count.Load() != 1 {
		t.Fatal("engine closed more than once")
	}
}

func TestManagerRetainsActiveOwnerUntilCleanupFinishes(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	voice := &closingEngine{fakeEngine: newFakeEngine(), entered: entered, release: release}
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	var allocations atomic.Int32
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { allocations.Add(1); return voice, nil }}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- manager.Close("same") }()
	<-entered
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); err == nil {
		t.Fatal("replacement admitted before cleanup")
	}
	if err := manager.Inject(context.Background(), "same", engine.ContextItem{}); err == nil {
		t.Fatal("injected while stopping")
	}
	if allocations.Load() != 1 {
		t.Fatal("replacement allocated during cleanup")
	}
	close(release)
	if err := result(t, done); err != nil {
		t.Fatal(err)
	}
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return newFakeEngine(), nil }}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}); err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseAll(); err != nil {
		t.Fatal(err)
	}
}
func TestManagerRequestCancellationReleasesSetupClaim(t *testing.T) {
	entered := make(chan struct{})
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) {
		t.Error("joined after failed engine setup")
		return newFakeRoom(), nil
	}})
	manager.engine = opening{open: func(ctx context.Context) (engine.Session, error) { close(entered); <-ctx.Done(); return nil, ctx.Err() }}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := manager.Start(ctx, wire.Start{ID: "cancel"}); done <- err }()
	<-entered
	cancel()
	if err := result(t, done); !errors.Is(err, context.Canceled) {
		t.Fatalf("start = %v", err)
	}
	manager.mu.RLock()
	remaining := len(manager.sessions)
	manager.mu.RUnlock()
	if remaining != 0 {
		t.Fatal("request cancellation leaked ownership")
	}
}

func TestManagerStopReportsSetupCleanupFailure(t *testing.T) {
	for _, shutdown := range []bool{false, true} {
		t.Run(map[bool]string{false: "stop", true: "shutdown"}[shutdown], func(t *testing.T) {
			entered := make(chan struct{})
			cleanup := make(chan struct{})
			release := make(chan struct{})
			failure := errors.New("cleanup failed")
			voice := &closingEngine{fakeEngine: newFakeEngine(), entered: cleanup, release: release, failure: failure}
			manager := NewManager(joining{join: func(ctx context.Context) (room.Room, error) { close(entered); <-ctx.Done(); return nil, ctx.Err() }})
			manager.engine = opening{open: func(context.Context) (engine.Session, error) { return voice, nil }}
			start := make(chan error, 1)
			stop := make(chan error, 1)
			go func() { _, err := manager.Start(context.Background(), wire.Start{ID: "cleanup"}); start <- err }()
			<-entered
			go func() {
				if shutdown {
					stop <- manager.CloseAll()
					return
				}
				stop <- manager.Close("cleanup")
			}()
			<-cleanup
			close(release)
			if err := result(t, start); !errors.Is(err, failure) || !errors.Is(err, context.Canceled) {
				t.Fatalf("start lost errors: %v", err)
			}
			if err := result(t, stop); !errors.Is(err, failure) {
				t.Fatalf("stop lost cleanup error: %v", err)
			}
			if err := manager.Close("cleanup"); !errors.Is(err, failure) {
				t.Fatalf("repeated stop lost cleanup failure: %v", err)
			}
			if _, err := manager.Start(context.Background(), wire.Start{ID: "cleanup"}); err == nil {
				t.Fatal("replacement admitted after uncertain cleanup")
			}
		})
	}
}

func TestManagerRetainsActiveClaimAfterCleanupFailure(t *testing.T) {
	failure := errors.New("room or engine may still be active")
	voice := &closing{fakeEngine: newFakeEngine(), close: func() error { return failure }}
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return voice, nil }}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "failed"}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := manager.Close("failed"); !errors.Is(err, failure) {
			t.Fatalf("close failure lost: %v", err)
		}
		if _, err := manager.Start(context.Background(), wire.Start{ID: "failed"}); err == nil {
			t.Fatal("uncertain cleanup allowed replacement")
		}
	}
	if err := manager.CloseAll(); !errors.Is(err, failure) {
		t.Fatalf("shutdown failure lost: %v", err)
	}
	if voice.count.Load() != 1 {
		t.Fatal("close was retried despite retained failure")
	}
}
