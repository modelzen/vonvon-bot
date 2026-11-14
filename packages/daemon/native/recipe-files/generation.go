package main

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"path"
	"regexp"
	"strings"
)

var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var skillPath = regexp.MustCompile(`^native/skills/r-[0-9a-f-]{36}/(SKILL\.md|references/[a-f0-9]{64}\.txt)$`)

const maxFiles = 16*(64+1) + 194 + 64 + 4
const maxMaterialized = 20 * logicalCap

type entry struct {
	Name  string `json:"name"`
	SHA   string `json:"sha256"`
	Bytes int    `json:"bytes"`
	Data  []byte `json:"data,omitempty"`
}

func validName(s string) bool {
	return s == "manifest.json" || s == "effective.json" || s == "receipt.json" || s == "native/.claude-plugin/plugin.json" || skillPath.MatchString(s) || strings.HasPrefix(s, "parts/") && uuid.MatchString(s[6:]) || strings.HasPrefix(s, "effective/") && uuid.MatchString(s[10:])
}
func validatePlan(entries []entry, write bool) error {
	if len(entries) == 0 || len(entries) > maxFiles {
		return refused
	}
	total := 0
	seen := map[string]bool{}
	for _, v := range entries {
		if !validName(v.Name) || !digest.MatchString(v.SHA) || v.Bytes < 0 || v.Bytes > logicalCap || seen[v.Name] {
			return refused
		}
		seen[v.Name] = true
		total += v.Bytes
		if total > maxMaterialized || write && (len(v.Data) != v.Bytes || hash(v.Data) != v.SHA) {
			return refused
		}
	}
	if !seen["manifest.json"] || !seen["receipt.json"] {
		return refused
	}
	return nil
}

type tree struct {
	root    *held
	dirs    map[string]*held
	created []*held
}

func newTree(root *held) *tree { return &tree{root: root, dirs: map[string]*held{".": root}} }
func (t *tree) close() {
	for i := len(t.created) - 1; i >= 0; i-- {
		t.created[i].close()
	}
}
func (t *tree) dir(s string, create bool) (*held, error) {
	if h := t.dirs[s]; h != nil {
		return h, nil
	}
	parent, e := t.dir(path.Dir(s), create)
	if e != nil {
		return nil, e
	}
	mode := immutableDir
	if create {
		mode = newDir
	}
	h, e := child(parent, path.Base(s), mode)
	if e != nil {
		return nil, e
	}
	t.dirs[s] = h
	t.created = append(t.created, h)
	return h, nil
}
func (t *tree) verify(entries []entry) error {
	revisions := map[*held]metadata{}
	names := map[string]map[string]bool{}
	for _, v := range entries {
		for s := v.Name; s != "."; s = path.Dir(s) {
			parent := path.Dir(s)
			if names[parent] == nil {
				names[parent] = map[string]bool{}
			}
			names[parent][path.Base(s)] = true
		}
	}
	for s, expected := range names {
		h, e := t.dir(s, false)
		if e != nil {
			return e
		}
		revisions[h], e = inspect(h.file)
		if e != nil {
			return e
		}
		got, e := h.file.Readdirnames(len(expected) + 1)
		if e != nil && e != io.EOF {
			return e
		}
		if len(got) != len(expected) {
			return refused
		}
		for _, name := range got {
			if !expected[name] {
				return refused
			}
		}
	}
	for _, v := range entries {
		parent, e := t.dir(path.Dir(v.Name), false)
		if e != nil {
			return e
		}
		f, e := child(parent, path.Base(v.Name), read)
		if e != nil {
			return e
		}
		b, e := f.bytes(int64(v.Bytes))
		f.close()
		if e != nil || len(b) != v.Bytes || hash(b) != v.SHA || !f.meta.readonly {
			return refused
		}
	}
	for h, before := range revisions {
		after, e := inspect(h.file)
		if e != nil || after != before {
			return refused
		}
		if e = h.check(); e != nil {
			return e
		}
	}
	return t.root.check()
}
func makeOrOpen(parent *held, name string) (*held, error) {
	h, e := child(parent, name, newDir)
	if e == nil {
		if err := parent.file.Sync(); err != nil {
			h.close()
			return nil, err
		}
		return h, nil
	}
	if !isExists(e) {
		return nil, e
	}
	return child(parent, name, writableDir)
}
func slotDir(root *held, id string, write bool) (*held, func(), error) {
	bot := root
	var created []*held
	closeAll := func() {
		for i := len(created) - 1; i >= 0; i-- {
			created[i].close()
		}
	}
	if write {
		var e error
		bot, e = child(root.parent, root.name, writableDir)
		if e != nil {
			return nil, nil, e
		}
		created = append(created, bot)
		if bot.meta.id != root.meta.id {
			closeAll()
			return nil, nil, refused
		}
	}
	parent := bot
	for _, name := range []string{"recipe-generations", id} {
		var next *held
		var e error
		if write {
			next, e = makeOrOpen(parent, name)
		} else {
			next, e = child(parent, name, directory)
		}
		if e != nil {
			closeAll()
			return nil, nil, e
		}
		created = append(created, next)
		parent = next
	}
	return parent, closeAll, nil
}
func stage(slot *held, generation string, entries []entry) error {
	return stageWithBoundary(slot, generation, entries, nil)
}
func stageWithBoundary(slot *held, generation string, entries []entry, beforePublish func()) error {
	if e := validatePlan(entries, true); e != nil {
		return e
	}
	var nonce [16]byte
	if _, e := rand.Read(nonce[:]); e != nil {
		return e
	}
	name := ".staging-" + hex.EncodeToString(nonce[:])
	temp, e := child(slot, name, newDir)
	if e != nil {
		return e
	}
	defer temp.close()
	t := newTree(temp)
	defer t.close()
	var written []*held
	published := false
	defer func() {
		if published || !sameEntry(slot.file, name, temp.meta) {
			return
		}
		for i := len(written) - 1; i >= 0; i-- {
			v := written[i]
			if sameEntry(v.parent.file, v.name, v.meta) {
				_ = erase(v.parent.file, v.name, false)
			}
		}
		for i := len(t.created) - 1; i >= 0; i-- {
			d := t.created[i]
			if sameEntry(d.parent.file, d.name, d.meta) {
				_ = erase(d.parent.file, d.name, true)
				d.close()
			}
		}
		_ = erase(slot.file, name, true)
	}()
	for _, v := range entries {
		parent, e := t.dir(path.Dir(v.Name), true)
		if e != nil {
			return e
		}
		f, e := child(parent, path.Base(v.Name), newFile)
		if e != nil {
			return e
		}
		written = append(written, f)
		_, e = f.file.Write(v.Data)
		if e == nil {
			e = sealFile(f.file)
		}
		closeErr := f.file.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
	}
	for i := len(t.created) - 1; i >= 0; i-- {
		if e = t.created[i].file.Sync(); e != nil {
			return e
		}
	}
	if e = temp.file.Sync(); e != nil {
		return e
	}
	if e = t.verify(entries); e != nil {
		return e
	}
	if beforePublish != nil {
		beforePublish()
	}
	if e = temp.check(); e != nil {
		return e
	}
	if e = publish(slot.file, temp.file, name, generation); e != nil {
		if !isExists(e) {
			return e
		}
	} else {
		published = true
		t.close()
		temp.close()
	}
	if e = slot.file.Sync(); e != nil {
		return e
	}
	return verify(slot, generation, entries)
}
func verify(slot *held, generation string, entries []entry) error {
	if e := validatePlan(entries, false); e != nil {
		return e
	}
	h, e := child(slot, generation, immutableDir)
	if e != nil {
		return e
	}
	defer h.close()
	t := newTree(h)
	defer t.close()
	return t.verify(entries)
}
func load(slot *held, gen string, names []string) ([]document, error) {
	if len(names) > 196 {
		return nil, refused
	}
	h, e := child(slot, gen, immutableDir)
	if e != nil {
		return nil, e
	}
	defer h.close()
	t := newTree(h)
	defer t.close()
	var docs []document
	total := 0
	for _, s := range names {
		if s != "manifest.json" && s != "effective.json" && s != "receipt.json" && !((strings.HasPrefix(s, "parts/") || strings.HasPrefix(s, "effective/")) && validName(s)) {
			return nil, refused
		}
		p, e := t.dir(path.Dir(s), false)
		if e != nil {
			return nil, e
		}
		f, e := child(p, path.Base(s), read)
		if e != nil {
			return nil, e
		}
		cap := int64(fileCap)
		if s == "manifest.json" || s == "effective.json" {
			cap = logicalCap
		}
		if remaining := int64(logicalCap + fileCap - total); cap > remaining {
			cap = remaining
		}
		b, e := f.bytes(cap)
		f.close()
		if e != nil || !f.meta.readonly {
			return nil, refused
		}
		total += len(b)
		if total > logicalCap+fileCap {
			return nil, refused
		}
		docs = append(docs, document{Name: s, Data: b})
	}
	return docs, h.check()
}
