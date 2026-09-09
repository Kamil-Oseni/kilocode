// raya_change - Media frontend session ownership and engine selection policy.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine/qwen"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type Manager struct {
	rooms    room.Factory
	engine   engine.Engine
	mu       sync.RWMutex
	sessions map[string]*ownership
	closed   bool
}

func NewManager(rooms room.Factory) *Manager {
	return &Manager{rooms: rooms, engine: qwen.Engine{}, sessions: map[string]*ownership{}}
}

// An ownership claim exists throughout setup and teardown. A replacement cannot
// allocate resources until the previous owner has finished releasing them.
type ownership struct {
	ready   chan struct{}
	cancel  context.CancelFunc
	session *Session
	stopped bool
	closed  error
}

func (m *Manager) Start(ctx context.Context, input wire.Start) (wire.Started, error) {
	id := input.ID
	if id == "" {
		id = identifier()
	}
	run, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	claim := &ownership{ready: make(chan struct{}), cancel: cancel}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		cancel()
		return wire.Started{}, errors.New("media frontend is shutting down")
	}
	if _, found := m.sessions[id]; found {
		m.mu.Unlock()
		cancel()
		return wire.Started{}, errors.New("voice session already exists; close it before reconnecting, or restart the media frontend if cleanup failed")
	}
	m.sessions[id] = claim
	m.mu.Unlock()
	defer close(claim.ready)
	defer func() {
		if claim.session == nil {
			cancel()
			if claim.closed == nil {
				m.release(id, claim)
			}
		}
	}()
	voice, err := m.engine.Open(run, input.Engine)
	if err != nil {
		return wire.Started{}, err
	}
	media, err := m.rooms.Join(run, input.LiveKitURL, input.LiveKitToken, input.Room)
	if err != nil {
		claim.closed = voice.Close()
		return wire.Started{}, errors.Join(err, cleanup(claim.closed))
	}
	stop()
	m.mu.Lock()
	if claim.stopped || ctx.Err() != nil || run.Err() != nil {
		m.mu.Unlock()
		claim.closed = errors.Join(media.Close(), voice.Close())
		return wire.Started{}, errors.Join(context.Canceled, cleanup(claim.closed))
	}
	var backend Backend
	if input.BackendURL != "" {
		backend = HTTPBackend{URL: input.BackendURL, Auth: input.BackendAuth, Directory: input.Directory}
	}
	claim.session = NewSession(
		run,
		id,
		voice,
		media,
		backend,
	)
	m.mu.Unlock()
	return wire.Started{ID: id, Descriptor: m.engine.Descriptor(), StartedAt: time.Now()}, nil
}

func (m *Manager) Inject(ctx context.Context, id string, item engine.ContextItem) error {
	m.mu.RLock()
	claim := m.sessions[id]
	if claim == nil || claim.session == nil || claim.stopped {
		m.mu.RUnlock()
		return errors.New("voice session is not active; reconnect before sending context")
	}
	session := claim.session
	m.mu.RUnlock()
	return session.Inject(ctx, item)
}

func (m *Manager) Status(id string) (wire.Status, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	claim := m.sessions[id]
	if claim == nil {
		return wire.Status{}, false
	}
	if claim.session != nil {
		return claim.session.Status(), true
	}
	select {
	case <-claim.ready:
		if claim.closed != nil {
			return wire.Status{ID: id, State: "failed", Cleanup: "failed"}, true
		}
	default:
	}
	return wire.Status{ID: id, State: "starting"}, true
}

func (m *Manager) release(id string, claim *ownership) {
	m.mu.Lock()
	if m.sessions[id] == claim {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
}

func (m *Manager) Close(id string) error {
	m.mu.Lock()
	claim := m.sessions[id]
	if claim == nil {
		m.mu.Unlock()
		return errors.New("voice session not found")
	}
	claim.stopped = true
	claim.cancel()
	m.mu.Unlock()
	return m.finish(id, claim)
}

func (m *Manager) finish(id string, claim *ownership) error {
	<-claim.ready
	err := claim.closed
	if claim.session != nil {
		err = claim.session.Close()
	}
	if err == nil {
		m.release(id, claim)
	}
	return cleanup(err)
}

func (m *Manager) CloseAll() error {
	m.mu.Lock()
	m.closed = true
	claims := make(map[string]*ownership, len(m.sessions))
	for id, claim := range m.sessions {
		claim.stopped = true
		claim.cancel()
		claims[id] = claim
	}
	m.mu.Unlock()
	errs := make([]error, 0, len(claims))
	for id, claim := range claims {
		errs = append(errs, m.finish(id, claim))
	}
	return errors.Join(errs...)
}

// A close error leaves release uncertain. Retain ownership until process restart
// instead of allocating a second engine/room over potentially live resources.
func cleanup(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("voice cleanup failed; restart the media frontend before reconnecting: %w", err)
}

func identifier() string {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	return "rvs_" + hex.EncodeToString(raw)
}
