//go:build linux

package process

import (
	"os/exec"
	"runtime"
	"syscall"
)

func hidden(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// Go's fork path also checks for reparenting after installing this signal.
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}

func owner() func() {
	// Pdeathsig watches the creating OS thread, not only the parent process.
	// Keep that thread alive until the child has actually been waited upon.
	runtime.LockOSThread()
	return runtime.UnlockOSThread
}
