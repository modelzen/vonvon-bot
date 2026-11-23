package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
)

type request struct {
	Operation, Root, Provider, Installation, Generation, ExpectedRoot string
	Names                                                             []string
	Entries                                                           []entry
}
type response struct {
	Root   string        `json:"root"`
	Names  []string      `json:"names,omitempty"`
	Skills []skillOption `json:"skills,omitempty"`
	Files  []document    `json:"files,omitempty"`
}

func run(r request) (response, error) {
	h, closeAll, e := openRoot(r.Root)
	if e != nil {
		return response{}, e
	}
	defer closeAll()
	out := response{Root: hash([]byte(h.meta.id))}
	if r.ExpectedRoot != "" && r.ExpectedRoot != out.Root {
		return response{}, refused
	}
	if r.Operation == "documents" {
		budget := 2048
		e = discoverDocuments(h, "", 0, &budget, &out.Names, true)
		sort.Strings(out.Names)
		return out, e
	}
	if r.Operation == "skills" {
		out.Skills, e = skillOptions(h, r.Provider)
		return out, e
	}
	if r.Operation == "identity" {
		return out, nil
	}
	if r.Operation == "source" {
		out.Files, e = selected(h, r.Names)
		return out, e
	}
	if !uuid.MatchString(r.Installation) || !uuid.MatchString(r.Generation) {
		return response{}, refused
	}
	slot, closeSlot, e := slotDir(h, r.Installation, r.Operation == "stage")
	if e != nil {
		return response{}, e
	}
	defer closeSlot()
	switch r.Operation {
	case "stage":
		e = stage(slot, r.Generation, r.Entries)
	case "verify":
		e = verify(slot, r.Generation, r.Entries)
	case "load":
		out.Files, e = load(slot, r.Generation, r.Names)
	default:
		e = refused
	}
	return out, e
}
func main() {
	const cap = 30 * 1024 * 1024
	b, e := io.ReadAll(io.LimitReader(os.Stdin, cap+1))
	var r request
	if e != nil || len(b) > cap || json.Unmarshal(b, &r) != nil {
		os.Exit(2)
	}
	out, e := run(r)
	if e != nil {
		fmt.Fprintln(os.Stderr, "Recipe file operation refused")
		os.Exit(1)
	}
	if json.NewEncoder(os.Stdout).Encode(out) != nil {
		os.Exit(1)
	}
}
