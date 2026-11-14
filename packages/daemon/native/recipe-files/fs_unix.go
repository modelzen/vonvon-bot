//go:build darwin || linux

package main

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
)

func openVolume(base string) (*os.File, error) { return os.Open(base) }
func openChild(parent *os.File, name string, mode access) (*os.File, error) {
	var expected unix.Stat_t
	flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	if mode == newDir {
		if e := unix.Mkdirat(int(parent.Fd()), name, 0700); e != nil {
			return nil, e
		}
	}
	if mode == newFile {
		flags = unix.O_CREAT | unix.O_EXCL | unix.O_WRONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
	} else if mode != read {
		flags |= unix.O_DIRECTORY
	} else {
		// Opening a device may have side effects even with O_NONBLOCK. Reject it before opening, and check the actual descriptor again.
		if e := unix.Fstatat(int(parent.Fd()), name, &expected, unix.AT_SYMLINK_NOFOLLOW); e != nil {
			return nil, e
		}
		if expected.Mode&unix.S_IFMT != unix.S_IFREG || expected.Nlink != 1 {
			return nil, refused
		}
	}
	fd, e := unix.Openat(int(parent.Fd()), name, flags, 0400)
	if e != nil {
		return nil, e
	}
	if mode == read {
		var actual unix.Stat_t
		if unix.Fstat(fd, &actual) != nil || objectID(&actual) != objectID(&expected) || actual.Ctim != expected.Ctim {
			unix.Close(fd)
			return nil, refused
		}
	}
	return os.NewFile(uintptr(fd), name), nil
}
func objectID(s *unix.Stat_t) string { return fmt.Sprintf("%x-%x", s.Dev, s.Ino) }
func inspect(f *os.File) (metadata, error) {
	var s unix.Stat_t
	if e := unix.Fstat(int(f.Fd()), &s); e != nil {
		return metadata{}, e
	}
	dir := s.Mode&unix.S_IFMT == unix.S_IFDIR
	if !dir && (s.Mode&unix.S_IFMT != unix.S_IFREG || s.Nlink != 1) {
		return metadata{}, refused
	}
	return metadata{objectID(&s), fmt.Sprintf("%x.%x-%x.%x", s.Ctim.Sec, s.Ctim.Nsec, s.Mtim.Sec, s.Mtim.Nsec), s.Size, dir, s.Mode&0222 == 0}, nil
}
func sameEntry(parent *os.File, name string, old metadata) bool {
	var s unix.Stat_t
	return unix.Fstatat(int(parent.Fd()), name, &s, unix.AT_SYMLINK_NOFOLLOW) == nil && old.id == objectID(&s)
}
func sealFile(f *os.File) error {
	if e := f.Chmod(0400); e != nil {
		return e
	}
	return f.Sync()
}
func erase(parent *os.File, name string, dir bool) error {
	flags := 0
	if dir {
		flags = unix.AT_REMOVEDIR
	}
	return unix.Unlinkat(int(parent.Fd()), name, flags)
}
func isExists(e error) bool { return e == unix.EEXIST }
