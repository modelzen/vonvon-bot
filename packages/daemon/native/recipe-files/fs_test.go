package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func fixtureRoot(t *testing.T) string {
	t.Helper()
	p, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	return p
}

// A child exits in the middle of staging. The OS closes its handles without running Go defers.
func TestInterruptedStage(t *testing.T) {
	if p := os.Getenv("VONVON_FIXTURE_CRASH_ROOT"); p != "" {
		var r request
		if json.Unmarshal([]byte(p), &r) != nil {
			os.Exit(2)
		}
		root, _, e := openRoot(r.Root)
		if e != nil {
			os.Exit(2)
		}
		slot, _, e := slotDir(root, r.Installation, true)
		if e != nil {
			os.Exit(2)
		}
		stageWithBoundary(slot, r.Generation, r.Entries, func() { os.Exit(73) })
		os.Exit(2)
	}
	root := fixtureRoot(t)
	manifest := []byte("baseline")
	receipt := []byte("receipt")
	r := request{Operation: "stage", Root: root, Installation: "10000000-0000-4000-8000-000000000001", Generation: "20000000-0000-4000-8000-000000000001", Entries: []entry{{"manifest.json", hash(manifest), len(manifest), manifest}, {"receipt.json", hash(receipt), len(receipt), receipt}}}
	encoded, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestInterruptedStage$")
	cmd.Env = append(os.Environ(), "VONVON_FIXTURE_CRASH_ROOT="+string(encoded))
	if e = cmd.Run(); e == nil || cmd.ProcessState.ExitCode() != 73 {
		t.Fatalf("child failed to reach publication: %v", e)
	}
	name := filepath.Join(root, "recipe-generations", r.Installation, r.Generation)
	if _, e = os.Lstat(name); !os.IsNotExist(e) {
		t.Fatalf("generation exists before commit: %v", e)
	}
	if _, e = run(r); e != nil {
		t.Fatal(e)
	}
	r.Operation = "verify"
	if _, e = run(r); e != nil {
		t.Fatal(e)
	}
	r.Operation = "stage"
	if _, e = run(r); e != nil {
		t.Fatal(e)
	}
}

func TestReadAfterMutation(t *testing.T) {
	dir := fixtureRoot(t)
	path := filepath.Join(dir, "readme.txt")
	if e := os.WriteFile(path, []byte("first"), 0600); e != nil {
		t.Fatal(e)
	}
	root, closeRoot, e := openRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer closeRoot()
	file, e := child(root, "readme.txt", read)
	if e != nil {
		t.Fatal(e)
	}
	defer file.close()
	if e = os.WriteFile(path, []byte("other"), 0600); e != nil {
		if writerExcluded(e) {
			return
		}
		t.Fatal(e)
	}
	if _, e = file.bytes(fileCap); e == nil {
		t.Fatal("changed held file was accepted")
	}
}
func TestHeldDirectoryReplacement(t *testing.T) {
	dir := fixtureRoot(t)
	p := filepath.Join(dir, "selected")
	if e := os.Mkdir(p, 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(p, "readme.md"), []byte("original"), 0600); e != nil {
		t.Fatal(e)
	}
	root, closeRoot, e := openRoot(p)
	if e != nil {
		t.Fatal(e)
	}
	defer closeRoot()
	if e = os.Rename(p, p+"-old"); e != nil {
		if writerExcluded(e) {
			return
		}
		t.Fatal(e)
	}
	if e = os.Mkdir(p, 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(p, "readme.md"), []byte("replaced"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = selected(root, []string{"readme.md"}); e == nil {
		t.Fatal("replaced approved root accepted")
	}
}

func TestReadAfterMutationWithAliasedMetadata(t *testing.T) {
	dir := fixtureRoot(t)
	path := filepath.Join(dir, "readme.txt")
	if e := os.WriteFile(path, []byte("first"), 0600); e != nil {
		t.Fatal(e)
	}
	root, done, e := openRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer done()
	file, e := child(root, "readme.txt", read)
	if e != nil {
		t.Fatal(e)
	}
	defer file.close()
	if e = os.WriteFile(path, []byte("other"), 0600); e != nil {
		if writerExcluded(e) {
			return
		}
		t.Fatal(e)
	}
	// Model a filesystem whose revision timestamps alias across this overwrite.
	file.meta, e = inspect(file.file)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = file.bytes(fileCap); e == nil {
		t.Fatal("changed bytes with aliased metadata accepted")
	}
	if e = file.check(); e == nil {
		t.Fatal("final check accepted changed bytes with aliased metadata")
	}
}

func TestHeldReadIsRepeatable(t *testing.T) {
	dir := fixtureRoot(t)
	if e := os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("stable"), 0600); e != nil {
		t.Fatal(e)
	}
	root, done, e := openRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer done()
	file, e := child(root, "readme.txt", read)
	if e != nil {
		t.Fatal(e)
	}
	defer file.close()
	for i := 0; i < 2; i++ {
		b, e := file.bytes(fileCap)
		if e != nil || string(b) != "stable" {
			t.Fatalf("unchanged held read failed: %q %v", b, e)
		}
	}
}

func TestHeldReadLimits(t *testing.T) {
	dir := fixtureRoot(t)
	path := filepath.Join(dir, "readme.txt")
	if e := os.WriteFile(path, make([]byte, fileCap+1), 0600); e != nil {
		t.Fatal(e)
	}
	root, done, e := openRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer done()
	file, e := child(root, "readme.txt", read)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = file.bytes(fileCap); e == nil {
		t.Fatal("oversized source read accepted")
	}
	file.close()
	if e = os.WriteFile(path, make([]byte, logicalCap+1), 0600); e != nil {
		t.Fatal(e)
	}
	file, e = child(root, "readme.txt", read)
	if e == nil {
		file.close()
		t.Fatal("oversized held snapshot accepted")
	}
}
