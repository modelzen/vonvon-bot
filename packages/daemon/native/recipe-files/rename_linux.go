package main

import (
	"golang.org/x/sys/unix"
	"os"
)

func publish(parent, _ *os.File, from, to string) error {
	return unix.Renameat2(int(parent.Fd()), from, int(parent.Fd()), to, unix.RENAME_NOREPLACE)
}
