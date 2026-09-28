// raya_change - Media frontend session ownership and engine selection policy.
package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine/live"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/engine/qwen"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/room"
	"github.com/Kilo-Org/kilocode/services/raya-mf/internal/wire"
)

type Manager struct {
	rooms    room.Factory
	engine   engine.Engine
	live     engine.Engine
	mu       sync.RWMutex
	sessions map[string]*ownership
	limit    int
	timeout  time.Duration
	closed   bool
}

var (
	ErrAuthorization = errors.New("media control authorization failed")
	ErrCapacity      = errors.New("media frontend session capacity reached")
	ErrSetupTimeout  = errors.New("voice session setup timed out")
)

const (
	sessionLimit = 8
	setupTimeout = 15 * time.Second
)

func NewManager(rooms room.Factory) *Manager {
	return &Manager{
		rooms: rooms, engine: qwen.Engine{}, live: live.Engine{}, sessions: map[string]*ownership{},
		limit: sessionLimit, timeout: setupTimeout,
	}
}

// An ownership claim exists throughout setup and teardown. A replacement cannot
// allocate resources until the previous owner has finished releasing them.
type ownership struct {
	ready   chan struct{}
	cancel  context.CancelFunc
	session *Session
	stopped bool
	closed  error
	token   [sha256.Size]byte
}

func (m *Manager) Start(ctx context.Context, input wire.Start, token string) (wire.Started, error) {
	if len(token) < 32 {
		return wire.Started{}, ErrAuthorization
	}
	if input.Version != 0 && input.Version != 2 {
		return wire.Started{}, errors.New("unsupported media start contract version")
	}
	if input.Engine.Provider != "" && input.Version != 2 {
		return wire.Started{}, errors.New("explicit voice provider requires media start contract version two")
	}
	selected := m.engine
	provider := input.Engine.Provider
	if provider == "" && input.Engine.Model == "gpt-live-1" {
		provider = "openai-live"
	}
	switch provider {
	case "", "qwen-realtime":
		if input.Engine.Model == "gpt-live-1" {
			return wire.Started{}, errors.New("voice model does not match the selected provider")
		}
	case "openai-live":
		if input.Version != 2 {
			return wire.Started{}, errors.New("OpenAI Live requires media start contract version two")
		}
		if input.Engine.Model != "" && input.Engine.Model != "gpt-live-1" {
			return wire.Started{}, errors.New("unsupported OpenAI Live voice model")
		}
		if _, ok := m.rooms.(room.AudioAuthority); !ok {
			return wire.Started{}, errors.New("OpenAI Live requires an audio-rate-aware room driver")
		}
		selected = m.live
	default:
		return wire.Started{}, errors.New("unsupported voice provider")
	}
	if input.BackendURL != "" {
		backend, err := local(input.BackendURL)
		if err != nil {
			return wire.Started{}, err
		}
		input.BackendURL = backend
	}
	id := input.ID
	if id == "" {
		id = identifier()
	}
	run, cancel, err := lifetime(ctx, input.Engine, provider == "openai-live")
	if err != nil {
		return wire.Started{}, err
	}
	stop := context.AfterFunc(ctx, cancel)
	defer stop()
	expired := false
	var expiry sync.Mutex
	timer := time.AfterFunc(m.timeout, func() {
		expiry.Lock()
		expired = true
		expiry.Unlock()
		cancel()
	})
	defer timer.Stop()
	claim := &ownership{ready: make(chan struct{}), cancel: cancel, token: sha256.Sum256([]byte(token))}
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
	if len(m.sessions) >= m.limit {
		m.mu.Unlock()
		cancel()
		return wire.Started{}, ErrCapacity
	}
	m.sessions[id] = claim
	m.mu.Unlock()
	reporter := setup{id: id, backend: HTTPBackend{URL: input.BackendURL, Auth: input.BackendAuth, Directory: input.Directory, Control: token}}
	defer close(claim.ready)
	defer func() {
		if claim.session == nil {
			cancel()
			if claim.closed == nil {
				m.release(id, claim)
			}
		}
	}()
	voice, err := selected.Open(run, input.Engine)
	if err != nil {
		if provider == "openai-live" {
			claim.closed = reporter.failed(nil, err)
		}
		expiry.Lock()
		timedout := expired
		expiry.Unlock()
		if timedout || errors.Is(run.Err(), context.DeadlineExceeded) {
			return wire.Started{}, errors.Join(ErrSetupTimeout, err, cleanup(claim.closed))
		}
		return wire.Started{}, errors.Join(err, cleanup(claim.closed))
	}
	media, err := func() (room.Room, error) {
		if factory, ok := m.rooms.(room.AudioAuthority); ok {
			return factory.JoinAudioAuthorized(run, input.LiveKitURL, input.LiveKitToken, input.Room, "client-"+id, selected.Descriptor().InputRate)
		}
		if factory, ok := m.rooms.(room.Authority); ok {
			return factory.JoinAuthorized(run, input.LiveKitURL, input.LiveKitToken, input.Room, "client-"+id)
		}
		return m.rooms.Join(run, input.LiveKitURL, input.LiveKitToken, input.Room)
	}()
	if err != nil {
		if provider == "openai-live" {
			claim.closed = reporter.failed(voice, err)
		} else {
			claim.closed = voice.Close()
		}
		expiry.Lock()
		timedout := expired
		expiry.Unlock()
		if timedout || errors.Is(run.Err(), context.DeadlineExceeded) {
			return wire.Started{}, errors.Join(ErrSetupTimeout, err, cleanup(claim.closed))
		}
		return wire.Started{}, errors.Join(err, cleanup(claim.closed))
	}
	timer.Stop()
	stop()
	m.mu.Lock()
	if claim.stopped || ctx.Err() != nil || run.Err() != nil || (provider == "openai-live" && !active(voice)) {
		m.mu.Unlock()
		if provider == "openai-live" {
			claim.closed = errors.Join(media.Close(), reporter.failed(voice, context.Canceled))
		} else {
			claim.closed = errors.Join(media.Close(), voice.Close())
		}
		return wire.Started{}, errors.Join(context.Canceled, cleanup(claim.closed))
	}
	var backend Backend
	if input.BackendURL != "" {
		capability := ""
		if provider == "openai-live" {
			capability = token
		}
		backend = HTTPBackend{URL: input.BackendURL, Auth: input.BackendAuth, Directory: input.Directory, Control: capability, Strict: provider == "openai-live"}
	}
	claim.session = func() *Session {
		if provider == "openai-live" {
			return NewSessionWithDescriptor(run, id, voice, media, backend, "client-"+id, selected.Descriptor())
		}
		return NewSession(run, id, voice, media, backend, "client-"+id)
	}()
	context.AfterFunc(claim.session.ctx, cancel)
	m.mu.Unlock()
	return wire.Started{ID: id, Descriptor: selected.Descriptor(), StartedAt: time.Now()}, nil
}

func (m *Manager) Inject(ctx context.Context, id string, token string, item engine.ContextItem) error {
	m.mu.RLock()
	claim := m.sessions[id]
	if claim == nil || claim.session == nil || claim.stopped {
		m.mu.RUnlock()
		return errors.New("voice session is not active; reconnect before sending context")
	}
	if !authorized(claim, token) {
		m.mu.RUnlock()
		return ErrAuthorization
	}
	session := claim.session
	m.mu.RUnlock()
	return session.Inject(ctx, item)
}

func (m *Manager) Result(ctx context.Context, id string, token string, result engine.Result) error {
	m.mu.RLock()
	claim := m.sessions[id]
	if claim == nil || claim.session == nil || claim.stopped {
		m.mu.RUnlock()
		return errors.New("voice session is not active")
	}
	if !authorized(claim, token) {
		m.mu.RUnlock()
		return ErrAuthorization
	}
	session := claim.session
	m.mu.RUnlock()
	return session.Result(ctx, result)
}

func (m *Manager) Status(id string, token string) (wire.Status, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	claim := m.sessions[id]
	if claim == nil {
		return wire.Status{}, false, nil
	}
	if !authorized(claim, token) {
		return wire.Status{}, true, ErrAuthorization
	}
	if claim.session != nil {
		return claim.session.Status(), true, nil
	}
	select {
	case <-claim.ready:
		if claim.closed != nil {
			return wire.Status{ID: id, State: "failed", Cleanup: "failed"}, true, nil
		}
	default:
	}
	return wire.Status{ID: id, State: "starting"}, true, nil
}

func (m *Manager) release(id string, claim *ownership) {
	m.mu.Lock()
	if m.sessions[id] == claim {
		delete(m.sessions, id)
	}
	m.mu.Unlock()
}

func (m *Manager) Close(id string, token string) error {
	m.mu.Lock()
	claim := m.sessions[id]
	if claim == nil {
		m.mu.Unlock()
		return errors.New("voice session not found")
	}
	if !authorized(claim, token) {
		m.mu.Unlock()
		return ErrAuthorization
	}
	claim.stopped = true
	claim.cancel()
	m.mu.Unlock()
	return m.finish(id, claim)
}

func authorized(claim *ownership, token string) bool {
	digest := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(claim.token[:], digest[:]) == 1
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
