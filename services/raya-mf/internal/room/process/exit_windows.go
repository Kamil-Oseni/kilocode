//go:build windows

package process

import "os"

func termination(_ *os.ProcessState) (bool, int) { return false, 0 }
