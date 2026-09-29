package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

const mediaAuth = "0123456789abcdef0123456789abcdef"

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

type binding struct {
	joining
	client string
	media  room.Room
}

func (a *binding) JoinAuthorized(_ context.Context, _, _, _, client string) (room.Room, error) {
	a.client = client
	return a.media, nil
}

func TestManagerBindsClientBeforeRoomSubscription(t *testing.T) {
	factory := &binding{media: newFakeRoom(), joining: joining{join: func(context.Context) (room.Room, error) {
		t.Fatal("authorized room fell back to an unbound join")
		return nil, errors.New("unbound")
	}}}
	manager := NewManager(factory)
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return newFakeEngine(), nil }}
	const id = "rvs_bound"
	if _, err := manager.Start(context.Background(), wire.Start{ID: id}, mediaAuth); err != nil {
		t.Fatal(err)
	}
	defer manager.Close(id, mediaAuth)
	if factory.client != "client-"+id || manager.sessions[id].session.client != factory.client {
		t.Fatal("room subscription and receipt owner did not share the minted identity")
	}
}

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
	go func() { _, err := manager.Start(ctx, wire.Start{ID: "same"}, mediaAuth); done <- err }()
	lifetime := <-entered
	if lifetime.Value(struct{}{}) != "trace" {
		t.Fatal("setup lost request context values")
	}
	for range 20 {
		if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); err == nil {
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
	if err := manager.Close("same", mediaAuth); err != nil {
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
	go func() { _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); start <- err }()
	<-entered
	go func() { stop <- manager.Close("same", mediaAuth) }()
	<-closing
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); err == nil {
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
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); err != nil {
		t.Fatal(err)
	}
	if err := manager.CloseAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "other"}, mediaAuth); err == nil {
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
		_, err := manager.Start(context.Background(), wire.Start{ID: "retry"}, mediaAuth)
		if !errors.Is(err, setup) {
			t.Fatalf("errors lost: %v", err)
		}
	}
	if voice.count.Load() != 2 {
		t.Fatal("setup leaked engine")
	}
}

type setupCleanup struct {
	done  chan struct{}
	err   error
	reads atomic.Int32
}

func (s *setupCleanup) Done() <-chan struct{} { return s.done }
func (s *setupCleanup) Err() error            { s.reads.Add(1); return s.err }

func TestManagerFailedJoinRetainsCleanupUntilAuthenticatedReconciliation(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(map[bool]string{false: "confirmed", true: "failure"}[failed], func(t *testing.T) {
			cause := errors.New("join failed")
			owner := &setupCleanup{done: make(chan struct{})}
			if failed {
				owner.err = errors.New("decoder close failed")
			}
			voice := &closing{fakeEngine: newFakeEngine()}
			var opens, joins atomic.Int32
			manager := NewManager(joining{join: func(context.Context) (room.Room, error) {
				joins.Add(1)
				return nil, &room.SetupError{Cause: cause, Cleanup: owner}
			}})
			manager.engine = opening{open: func(context.Context) (engine.Session, error) {
				opens.Add(1)
				return voice, nil
			}}
			if _, err := manager.Start(context.Background(), wire.Start{ID: "failed_join"}, mediaAuth); !errors.Is(err, cause) {
				t.Fatalf("lost setup cause: %v", err)
			}
			if voice.count.Load() != 1 {
				t.Fatal("failed setup did not close the original provider exactly once")
			}
			state, found, err := manager.Status("failed_join", mediaAuth)
			if err != nil || !found || state.State != "failed" || state.Cleanup != "unknown" {
				t.Fatalf("pending cleanup status: %+v, %v", state, err)
			}
			if err := manager.Close("failed_join", "wrong-token"); !errors.Is(err, ErrAuthorization) {
				t.Fatalf("foreign close accepted: %v", err)
			}
			if err := manager.Close("failed_join", mediaAuth); !errors.Is(err, ErrCleanupPending) {
				t.Fatalf("pending close lost ownership: %v", err)
			}
			if owner.reads.Load() != 0 {
				t.Fatal("read cleanup result before actual termination")
			}
			for _, id := range []string{"failed_join", "different_join"} {
				if _, err := manager.Start(context.Background(), wire.Start{ID: id}, mediaAuth); err == nil {
					t.Fatal("allocated while cleanup unknown")
				}
			}
			if opens.Load() != 1 || joins.Load() != 1 {
				t.Fatal("unknown cleanup allocated a new engine or room")
			}
			close(owner.done)
			if _, err := manager.Start(context.Background(), wire.Start{ID: "different_join"}, mediaAuth); !errors.Is(err, ErrCleanupPending) {
				t.Fatalf("termination automatically reconciled ownership: %v", err)
			}
			if err := manager.Close("failed_join", mediaAuth); !errors.Is(err, owner.err) {
				t.Fatalf("reconciliation error: %v", err)
			}
			if voice.count.Load() != 1 {
				t.Fatal("reconciliation replayed provider teardown")
			}
			if failed {
				if _, err := manager.Start(context.Background(), wire.Start{ID: "different_join"}, mediaAuth); !errors.Is(err, ErrCleanupPending) {
					t.Fatalf("failed cleanup allowed allocation: %v", err)
				}
				return
			}
			manager.rooms = joining{join: func(context.Context) (room.Room, error) { joins.Add(1); return newFakeRoom(), nil }}
			manager.engine = opening{open: func(context.Context) (engine.Session, error) { opens.Add(1); return newFakeEngine(), nil }}
			if _, err := manager.Start(context.Background(), wire.Start{ID: "failed_join"}, mediaAuth); err != nil {
				t.Fatal(err)
			}
			if opens.Load() != 2 || joins.Load() != 2 {
				t.Fatal("explicit retry did not allocate exactly once")
			}
			if err := manager.Close("failed_join", mediaAuth); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestManagerStopBoundsUncooperativeSetupWithoutReleasingItsClaim(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	voice := &closing{fakeEngine: newFakeEngine()}
	var opens atomic.Int32
	manager := NewManager(joining{join: func(ctx context.Context) (room.Room, error) {
		close(entered)
		<-release
		return nil, ctx.Err()
	}})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { opens.Add(1); return voice, nil }}
	start := make(chan error, 1)
	go func() {
		_, err := manager.Start(context.Background(), wire.Start{ID: "blocked_setup"}, mediaAuth)
		start <- err
	}()
	<-entered
	if err := manager.Close("blocked_setup", mediaAuth); !errors.Is(err, ErrCleanupPending) {
		t.Fatalf("blocked setup stop: %v", err)
	}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "different_setup"}, mediaAuth); !errors.Is(err, ErrCleanupPending) {
		t.Fatalf("stopped unknown setup allowed new allocation: %v", err)
	}
	if opens.Load() != 1 || voice.count.Load() != 0 {
		t.Fatal("unknown setup ownership was replaced or prematurely closed")
	}
	close(release)
	if err := result(t, start); !errors.Is(err, context.Canceled) {
		t.Fatalf("late setup completion: %v", err)
	}
	if voice.count.Load() != 1 {
		t.Fatal("late setup did not close exact original provider")
	}
	if _, found, err := manager.Status("blocked_setup", mediaAuth); err != nil || found {
		t.Fatalf("confirmed cleanup retained setup: %v", err)
	}
}

func TestManagerCompletedOwnerWithUnknownSDKCleanupRetainsLiveClaim(t *testing.T) {
	provider, calls := setupProvider(t, true)
	var reports, joins atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reports.Add(1)
		var event wire.Envelope
		if json.NewDecoder(r.Body).Decode(&event) != nil || event.Session != "rvs_setup" || event.Event.Session != "live_setup" || event.Event.Type != "session.setup.closed" || r.Header.Get("X-Raya-Voice-Capability") != mediaAuth {
			t.Error("SDK cleanup uncertainty changed the exact provider settlement")
		}
		_, _ = w.Write([]byte("true"))
	}))
	defer backend.Close()
	owner := &setupCleanup{done: make(chan struct{}), err: room.ErrCleanupUnknown}
	close(owner.done)
	cause := errors.New("native Join failed after owned cleanup")
	manager := NewManager(setupRooms{joining{join: func(context.Context) (room.Room, error) {
		joins.Add(1)
		return nil, &room.SetupError{Cause: cause, Cleanup: owner}
	}}})
	input := setupInput(provider.URL, backend.URL)
	if _, err := manager.Start(context.Background(), input, mediaAuth); !errors.Is(err, cause) {
		t.Fatalf("lost native setup error: %v", err)
	}
	for range 3 {
		status, found, err := manager.Status(input.ID, mediaAuth)
		if err != nil || !found || status.State != "failed" || status.Cleanup != "unknown" {
			t.Fatalf("joined Raya owner fabricated SDK termination: %+v, %v", status, err)
		}
		if err := manager.Close(input.ID, mediaAuth); !errors.Is(err, room.ErrCleanupUnknown) {
			t.Fatalf("SDK unknown receipt was lost: %v", err)
		}
		for _, id := range []string{input.ID, "rvs_other_sdk_cleanup"} {
			next := input
			next.ID = id
			if _, err := manager.Start(context.Background(), next, mediaAuth); err == nil {
				t.Fatal("unconfirmed SDK cleanup admitted replacement")
			}
		}
	}
	if calls.Load() != 1 || joins.Load() != 1 || reports.Load() != 1 {
		t.Fatal("unknown SDK cleanup replayed provider allocation, room join, or exact settlement")
	}
}

func TestManagerRequiresExactSessionCapability(t *testing.T) {
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return newFakeEngine(), nil }}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "protected"}, "short"); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("short capability accepted: %v", err)
	}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "protected"}, mediaAuth); err != nil {
		t.Fatal(err)
	}
	wrong := "fedcba9876543210fedcba9876543210"
	if _, found, err := manager.Status("protected", wrong); !found || !errors.Is(err, ErrAuthorization) {
		t.Fatalf("wrong status capability = found %t, error %v", found, err)
	}
	if err := manager.Inject(context.Background(), "protected", wrong, engine.ContextItem{}); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("wrong inject capability = %v", err)
	}
	if err := manager.Close("protected", wrong); !errors.Is(err, ErrAuthorization) {
		t.Fatalf("wrong close capability = %v", err)
	}
	if _, found, err := manager.Status("protected", mediaAuth); err != nil || !found {
		t.Fatalf("owner lost session after refused control: found %t, error %v", found, err)
	}
	if err := manager.Close("protected", mediaAuth); err != nil {
		t.Fatal(err)
	}
}

func TestManagerBoundsConcurrentAdmission(t *testing.T) {
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	manager.engine = opening{open: func(context.Context) (engine.Session, error) { return newFakeEngine(), nil }}
	manager.limit = 2
	for _, id := range []string{"first", "second"} {
		if _, err := manager.Start(context.Background(), wire.Start{ID: id}, mediaAuth); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "third"}, mediaAuth); !errors.Is(err, ErrCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
	if err := manager.Close("first", mediaAuth); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), wire.Start{ID: "third"}, mediaAuth); err != nil {
		t.Fatalf("released capacity was not reusable: %v", err)
	}
	if err := manager.CloseAll(); err != nil {
		t.Fatal(err)
	}
}

func TestManagerBoundsProviderSetupLifetime(t *testing.T) {
	manager := NewManager(joining{join: func(context.Context) (room.Room, error) { return newFakeRoom(), nil }})
	manager.timeout = 20 * time.Millisecond
	manager.engine = opening{open: func(ctx context.Context) (engine.Session, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	started := time.Now()
	_, err := manager.Start(context.Background(), wire.Start{ID: "stalled"}, mediaAuth)
	if !errors.Is(err, ErrSetupTimeout) || !errors.Is(err, context.Canceled) {
		t.Fatalf("setup error = %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("setup deadline did not settle promptly")
	}
	manager.mu.RLock()
	remaining := len(manager.sessions)
	manager.mu.RUnlock()
	if remaining != 0 {
		t.Fatal("timed-out setup retained capacity")
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
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- manager.Close("same", mediaAuth) }()
	<-entered
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); err == nil {
		t.Fatal("replacement admitted before cleanup")
	}
	if err := manager.Inject(context.Background(), "same", mediaAuth, engine.ContextItem{}); err == nil {
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
	if _, err := manager.Start(context.Background(), wire.Start{ID: "same"}, mediaAuth); err != nil {
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
	go func() { _, err := manager.Start(ctx, wire.Start{ID: "cancel"}, mediaAuth); done <- err }()
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
			go func() {
				_, err := manager.Start(context.Background(), wire.Start{ID: "cleanup"}, mediaAuth)
				start <- err
			}()
			<-entered
			go func() {
				if shutdown {
					stop <- manager.CloseAll()
					return
				}
				stop <- manager.Close("cleanup", mediaAuth)
			}()
			<-cleanup
			close(release)
			if err := result(t, start); !errors.Is(err, failure) || !errors.Is(err, context.Canceled) {
				t.Fatalf("start lost errors: %v", err)
			}
			if err := result(t, stop); !errors.Is(err, failure) {
				t.Fatalf("stop lost cleanup error: %v", err)
			}
			if err := manager.Close("cleanup", mediaAuth); !errors.Is(err, failure) {
				t.Fatalf("repeated stop lost cleanup failure: %v", err)
			}
			if _, err := manager.Start(context.Background(), wire.Start{ID: "cleanup"}, mediaAuth); err == nil {
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
	if _, err := manager.Start(context.Background(), wire.Start{ID: "failed"}, mediaAuth); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := manager.Close("failed", mediaAuth); !errors.Is(err, failure) {
			t.Fatalf("close failure lost: %v", err)
		}
		if _, err := manager.Start(context.Background(), wire.Start{ID: "failed"}, mediaAuth); err == nil {
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
