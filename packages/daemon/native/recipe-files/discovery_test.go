package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestConfinedSkillNames(t *testing.T) {
	root := fixtureRoot(t)
	skill := filepath.Join(root, ".agents", "skills", "Example")
	if e := os.MkdirAll(filepath.Join(skill, "reference"), 0700); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"SKILL.md", "reference/usage.rst", ".private.txt", "tool.sh"} {
		if e := os.WriteFile(filepath.Join(skill, name), []byte{255}, 0600); e != nil {
			t.Fatal(e)
		}
	}
	outside := fixtureRoot(t)
	foreign := filepath.Join(outside, "source.txt")
	if e := os.WriteFile(foreign, []byte("outside"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Link(foreign, filepath.Join(skill, "linked.txt")); e != nil {
		t.Fatal(e)
	}
	_ = os.Symlink(outside, filepath.Join(skill, "other"))
	r, e := run(request{Operation: "skills", Provider: ".agents", Root: root})
	if e != nil || !reflect.DeepEqual(r.Skills, []skillOption{{"Example", []string{"SKILL.md", "reference/usage.rst"}}}) {
		t.Fatalf("%+v %v", r, e)
	}
	if _, e = run(request{Operation: "skills", Provider: "../.private", Root: root}); e == nil {
		t.Fatal("unexpected provider")
	}
}
