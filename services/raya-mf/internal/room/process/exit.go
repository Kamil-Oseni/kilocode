package process

import "os"

// exit is diagnostic evidence, never an action completion or replay authority.
// StopRequested/KillRequested describe requests observed when Wait returned;
// they do not establish which event caused the child's exit.
type exit struct {
	Known         bool `json:"known"`
	Code          int  `json:"code"`
	Signaled      bool `json:"signaled"`
	Signal        int  `json:"signal"`
	StopRequested bool `json:"stopRequested"`
	KillRequested bool `json:"killRequested"`
}

func observed(state *os.ProcessState) exit {
	if state == nil {
		return exit{}
	}
	value := exit{Known: true, Code: state.ExitCode()}
	value.Signaled, value.Signal = signal(state)
	return value
}

func (p *Proxy) outcome() exit {
	select {
	case <-p.done:
		return p.exit
	default:
		return exit{}
	}
}
