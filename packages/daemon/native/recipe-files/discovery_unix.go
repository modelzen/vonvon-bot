//go:build darwin || linux

package main

import (
	"golang.org/x/sys/unix"
	"io"
)

func missingEntry(e error) bool { return e == unix.ENOENT }
func listNames(dir *held, limit int) ([]string, error) {
	names, e := dir.file.Readdirnames(limit + 1)
	if e != nil && e != io.EOF {
		return nil, e
	}
	if len(names) > limit {
		return nil, refused
	}
	return names, nil
}
func documentMetadata(parent *held, name string) (bool, bool) {
	var s unix.Stat_t
	regular := unix.Fstatat(int(parent.file.Fd()), name, &s, unix.AT_SYMLINK_NOFOLLOW) == nil && s.Mode&unix.S_IFMT == unix.S_IFREG && s.Nlink == 1
	return regular && s.Size <= fileCap, regular && s.Size > fileCap
}
