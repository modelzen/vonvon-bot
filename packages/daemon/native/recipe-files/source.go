package main

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

const fileCap = 128 * 1024
const logicalCap = 1024 * 1024

var device = regexp.MustCompile(`^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[1-9¹²³])$`)

func portable(s string) bool {
	if !utf8.ValidString(s) || len(s) > 240 || strings.ContainsAny(s, `\:<>"|?*`) {
		return false
	}
	switch strings.ToLower(path.Ext(s)) {
	case ".md", ".txt", ".rst":
	default:
		return false
	}
	for _, c := range s {
		if c < 32 || c == 127 {
			return false
		}
	}
	for _, part := range strings.Split(s, "/") {
		if part == "" || part[0] == '.' || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || device.MatchString(strings.ToUpper(strings.TrimRight(strings.SplitN(part, ".", 2)[0], " "))) {
			return false
		}
	}
	return true
}

type document struct {
	Name     string `json:"name"`
	Identity string `json:"identity"`
	Data     []byte `json:"data"`
}

func selected(root *held, names []string) ([]document, error) {
	if len(names) > 64 {
		return nil, refused
	}
	files := []document{}
	seen := map[string]bool{}
	directories := map[string]*held{"": root}
	heldFiles := []*held{}
	opened := []*held{}
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			opened[i].close()
		}
	}()
	total := 0
	for _, name := range names {
		if !portable(name) {
			return nil, refused
		}
		parent := root
		prefix := ""
		parts := strings.Split(name, "/")
		for _, part := range parts[:len(parts)-1] {
			prefix += part + "/"
			if directories[prefix] == nil {
				h, e := child(parent, part, directory)
				if e != nil {
					return nil, e
				}
				opened = append(opened, h)
				directories[prefix] = h
			}
			parent = directories[prefix]
		}
		h, e := child(parent, parts[len(parts)-1], read)
		if e != nil {
			return nil, e
		}
		opened = append(opened, h)
		heldFiles = append(heldFiles, h)
		if seen[h.meta.id] || h.meta.size > int64(logicalCap-total) {
			return nil, refused
		}
		seen[h.meta.id] = true
		bytes, e := h.bytes(fileCap)
		if e != nil || !utf8.Valid(bytes) {
			return nil, refused
		}
		total += len(bytes)
		files = append(files, document{name, hash([]byte(fmt.Sprintf("%s/%s", h.meta.id, h.meta.revision))), bytes})
	}
	for _, h := range heldFiles {
		if e := h.check(); e != nil {
			return nil, e
		}
	}
	return files, root.check()
}
