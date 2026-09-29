//go:build windows

package process

import "os"

func signal(_ *os.ProcessState) (bool, int) { return false, 0 }
