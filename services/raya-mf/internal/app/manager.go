// raya_change - Media frontend session ownership and engine selection policy.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	sessions map[string]*Session
}

func NewManager(rooms room.Factory) *Manager {
	return &Manager{rooms: rooms, engine: qwen.Engine{}, sessions: map[string]*Session{}}
}

func (m *Manager) Start(ctx context.Context, input wire.Start) (wire.Started, error) {
	id := input.ID
	if id == "" {
		id = identifier()
	}
	m.mu.RLock()
	_, found := m.sessions[id]
	m.mu.RUnlock()
	if found {
		return wire.Started{}, errors.New("voice session already exists")
	}
	voice, err := m.engine.Open(ctx, input.Engine)
	if err != nil {
		return wire.Started{}, err
	}
	media, err := m.rooms.Join(ctx, input.LiveKitURL, input.LiveKitToken, input.Room)
	if err != nil {
		_ = voice.Close()
		return wire.Started{}, err
	}
	session := NewSession(
		context.Background(),
		id,
		voice,
		media,
		HTTPBackend{URL: input.BackendURL, Auth: input.BackendAuth, Directory: input.Directory},
	)
	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()
	return wire.Started{ID: id, Descriptor: m.engine.Descriptor(), StartedAt: time.Now()}, nil
}

func (m *Manager) Inject(ctx context.Context, id string, item engine.ContextItem) error {
	m.mu.RLock()
	session := m.sessions[id]
	m.mu.RUnlock()
	if session == nil {
		return errors.New("voice session not found")
	}
	return session.Inject(ctx, item)
}

func (m *Manager) Close(id string) error {
	m.mu.Lock()
	session := m.sessions[id]
	delete(m.sessions, id)
	m.mu.Unlock()
	if session == nil {
		return errors.New("voice session not found")
	}
	return session.Close()
}

func (m *Manager) CloseAll() error {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	errs := make([]error, 0, len(sessions))
	for _, session := range sessions {
		errs = append(errs, session.Close())
	}
	return errors.Join(errs...)
}

func identifier() string {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	return "rvs_" + hex.EncodeToString(raw)
}
