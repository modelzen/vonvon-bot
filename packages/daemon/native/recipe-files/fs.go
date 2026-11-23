package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var refused = errors.New("recipe file operation refused")

type metadata struct {
	id, revision        string
	size                int64
	directory, readonly bool
}
type held struct {
	file   *os.File
	meta   metadata
	name   string
	parent *held
}
type access int

const (
	read access = iota
	directory
	immutableDir
	writableDir
	newDir
	newFile
)

func adopt(f *os.File, name string, parent *held, mode access) (*held, error) {
	m, e := inspect(f)
	if e != nil || m.directory != (mode != read && mode != newFile) {
		f.Close()
		return nil, refused
	}
	return &held{f, m, name, parent}, nil
}
func child(parent *held, name string, mode access) (*held, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\:\x00") {
		return nil, refused
	}
	f, e := openChild(parent.file, name, mode)
	if e != nil {
		return nil, e
	}
	return adopt(f, name, parent, mode)
}
func (h *held) check() error {
	m, e := inspect(h.file)
	if e != nil || m.id != h.meta.id || (!m.directory && m != h.meta) {
		return refused
	}
	if h.parent != nil {
		if !sameEntry(h.parent.file, h.name, h.meta) {
			return refused
		}
		return h.parent.check()
	}
	return nil
}
func (h *held) close() { h.file.Close() }
func (h *held) bytes(limit int64) ([]byte, error) {
	if h.meta.directory || h.meta.size > limit || h.meta.size < 0 {
		return nil, refused
	}
	b, e := io.ReadAll(io.LimitReader(h.file, h.meta.size+1))
	if e != nil || int64(len(b)) != h.meta.size {
		return nil, refused
	}
	return b, h.check()
}
func openRoot(path string) (*held, func(), error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, nil, refused
	}
	vol := filepath.VolumeName(path)
	base := vol + string(filepath.Separator)
	if path == base {
		return nil, nil, refused
	}
	f, e := openVolume(base)
	if e != nil {
		return nil, nil, e
	}
	h, e := adopt(f, base, nil, directory)
	if e != nil {
		return nil, nil, e
	}
	all := []*held{h}
	closeAll := func() {
		for i := len(all) - 1; i >= 0; i-- {
			all[i].close()
		}
	}
	for _, p := range strings.Split(strings.TrimPrefix(path, base), string(filepath.Separator)) {
		h, e = child(h, p, directory)
		if e != nil {
			closeAll()
			return nil, nil, e
		}
		all = append(all, h)
	}
	if e = h.check(); e != nil {
		closeAll()
		return nil, nil, e
	}
	return h, closeAll, nil
}
func hash(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }
