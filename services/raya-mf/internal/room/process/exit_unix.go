//go:build !windows

package process

import (
	"os"
	"syscall"
)

func termination(state *os.ProcessState) (bool, int) {
	value, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !value.Signaled() {
		return false, 0
	}
	return true, int(value.Signal())
}
