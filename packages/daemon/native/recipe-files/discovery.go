package main

import (
	"errors"
	"os"
	"regexp"
	"sort"
	"strings"
)

type skillOption struct {
	Name  string   `json:"name"`
	Files []string `json:"files"`
}

var skillName = regexp.MustCompile(`^[\pL\pN][\pL\pN _-]{0,79}$`)

// Only the bound workspace's named provider catalog is visited. No file bytes are opened for reading.
func skillOptions(workspace *held, provider string) ([]skillOption, error) {
	if provider != ".agents" && provider != ".claude" {
		return nil, refused
	}
	root := workspace
	for _, name := range []string{provider, "skills"} {
		dir, e := child(root, name, directory)
		if errors.Is(e, os.ErrNotExist) || missingEntry(e) {
			return []skillOption{}, nil
		}
		if e != nil {
			return nil, e
		}
		defer dir.close()
		root = dir
	}
	budget := 2048
	names, e := listNames(root, budget)
	if e != nil {
		return nil, e
	}
	budget -= len(names)
	options := []skillOption{}
	for _, name := range names {
		if !skillName.MatchString(name) {
			continue
		}
		dir, e := child(root, name, directory)
		if e != nil {
			continue
		}
		files := []string{}
		e = discoverDocuments(dir, "", 0, &budget, &files)
		dir.close()
		if e != nil {
			return nil, e
		}
		sort.Strings(files)
		if n := sort.SearchStrings(files, "SKILL.md"); n < len(files) && files[n] == "SKILL.md" {
			options = append(options, skillOption{name, files})
			if len(options) > 128 {
				return nil, refused
			}
		}
	}
	sort.Slice(options, func(i, j int) bool { return options[i].Name < options[j].Name })
	return options, root.check()
}
func discoverDocuments(dir *held, prefix string, depth int, budget *int, files *[]string) error {
	names, e := listNames(dir, *budget)
	if e != nil {
		return e
	}
	*budget -= len(names)
	for _, name := range names {
		relative := prefix + name
		if !portable(relative+"/a.md") || strings.EqualFold(name, "scripts") || len(relative) > 240 {
			continue
		}
		if portable(relative) {
			if ok := documentMetadata(dir, name); ok {
				*files = append(*files, relative)
				if len(*files) > 64 {
					return refused
				}
				continue
			}
		}
		if depth >= 6 {
			continue
		}
		sub, e := child(dir, name, directory)
		if e != nil {
			continue
		}
		e = discoverDocuments(sub, relative+"/", depth+1, budget, files)
		sub.close()
		if e != nil {
			return e
		}
	}
	return dir.check()
}
