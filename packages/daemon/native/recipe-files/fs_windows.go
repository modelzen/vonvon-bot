package main

import (
	"encoding/binary"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

func openVolume(base string) (*os.File, error) {
	if len(base) != 3 || base[1:] != ":\\" {
		return nil, refused
	}
	path, e := windows.UTF16PtrFromString(base)
	if e != nil {
		return nil, e
	}
	h, e := windows.CreateFile(path, windows.FILE_GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(h), base), nil
}
func ntOpen(parent *os.File, name string, access, share, disposition, options uint32) (*os.File, error) {
	n, e := windows.NewNTUnicodeString(name)
	if e != nil {
		return nil, e
	}
	oa := windows.OBJECT_ATTRIBUTES{RootDirectory: windows.Handle(parent.Fd()), ObjectName: n, Attributes: windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE}
	oa.Length = uint32(unsafe.Sizeof(oa))
	var h windows.Handle
	var status windows.IO_STATUS_BLOCK
	e = windows.NtCreateFile(&h, access|windows.SYNCHRONIZE, &oa, &status, nil, 0, share, disposition, options|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(h), name), nil
}
func openChild(parent *os.File, name string, mode access) (*os.File, error) {
	rights := uint32(windows.FILE_GENERIC_READ)
	share := uint32(windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE)
	disposition := uint32(windows.FILE_OPEN)
	options := uint32(windows.FILE_DIRECTORY_FILE)
	switch mode {
	case immutableDir:
		share = windows.FILE_SHARE_READ | windows.FILE_SHARE_DELETE
	case read:
		options = windows.FILE_NON_DIRECTORY_FILE
		share = windows.FILE_SHARE_READ
	case newFile:
		rights |= windows.FILE_GENERIC_WRITE
		disposition = windows.FILE_CREATE
		options = windows.FILE_NON_DIRECTORY_FILE | windows.FILE_WRITE_THROUGH
	case newDir:
		rights |= windows.FILE_GENERIC_WRITE | windows.DELETE
		disposition = windows.FILE_CREATE
	case writableDir:
		rights |= windows.FILE_GENERIC_WRITE
	}
	return ntOpen(parent, name, rights, share, disposition, options)
}

type basicInfo struct {
	creation, access, write, change int64
	attributes, padding             uint32
}

func inspect(f *os.File) (metadata, error) {
	h := windows.Handle(f.Fd())
	typ, e := windows.GetFileType(h)
	if e != nil || typ != windows.FILE_TYPE_DISK {
		return metadata{}, refused
	}
	var info windows.ByHandleFileInformation
	if e = windows.GetFileInformationByHandle(h, &info); e != nil {
		return metadata{}, e
	}
	dir := info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || (!dir && info.NumberOfLinks != 1) {
		return metadata{}, refused
	}
	var id [24]byte
	if e = windows.GetFileInformationByHandleEx(h, windows.FileIdInfo, &id[0], 24); e != nil {
		return metadata{}, e
	}
	var b basicInfo
	if e = windows.GetFileInformationByHandleEx(h, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&b)), uint32(unsafe.Sizeof(b))); e != nil {
		return metadata{}, e
	}
	if !dir && !onlyDefaultStream(h) {
		return metadata{}, refused
	}
	return metadata{fmt.Sprintf("%x", id), fmt.Sprintf("%x-%x", b.change, b.write), int64(info.FileSizeHigh)<<32 | int64(info.FileSizeLow), dir, info.FileAttributes&windows.FILE_ATTRIBUTE_READONLY != 0}, nil
}
func sameEntry(parent *os.File, name string, m metadata) bool {
	options := uint32(windows.FILE_NON_DIRECTORY_FILE)
	if m.directory {
		options = windows.FILE_DIRECTORY_FILE
	}
	f, e := ntOpen(parent, name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN, options)
	if e != nil {
		return false
	}
	defer f.Close()
	s, e := inspect(f)
	return e == nil && s.id == m.id
}
func setReadonly(f *os.File, on bool) error {
	var b basicInfo
	b.attributes = windows.FILE_ATTRIBUTE_NORMAL
	if on {
		b.attributes = windows.FILE_ATTRIBUTE_READONLY
	}
	return windows.SetFileInformationByHandle(windows.Handle(f.Fd()), windows.FileBasicInfo, (*byte)(unsafe.Pointer(&b)), uint32(unsafe.Sizeof(b)))
}
func sealFile(f *os.File) error {
	if e := setReadonly(f, true); e != nil {
		return e
	}
	return f.Sync()
}
func publish(parent, staged *os.File, _, to string) error {
	u, e := windows.UTF16FromString(to)
	if e != nil {
		return e
	}
	var layout struct {
		replace uint32
		parent  windows.Handle
		length  uint32
		name    uint16
	}
	off := int(unsafe.Offsetof(layout.name))
	buf := make([]byte, off+2*(len(u)-1))
	v := (*struct {
		replace uint32
		parent  windows.Handle
		length  uint32
	})(unsafe.Pointer(&buf[0]))
	v.parent = windows.Handle(parent.Fd())
	v.length = uint32(len(buf) - off)
	for i, c := range u[:len(u)-1] {
		buf[off+2*i] = byte(c)
		buf[off+2*i+1] = byte(c >> 8)
	}
	var status windows.IO_STATUS_BLOCK
	return windows.NtSetInformationFile(windows.Handle(staged.Fd()), &status, &buf[0], uint32(len(buf)), windows.FileRenameInformation)
}
func erase(parent *os.File, name string, dir bool) error {
	opt := uint32(windows.FILE_NON_DIRECTORY_FILE)
	if dir {
		opt = windows.FILE_DIRECTORY_FILE
	}
	f, e := ntOpen(parent, name, windows.DELETE|windows.FILE_WRITE_ATTRIBUTES|windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN, opt)
	if e != nil {
		return e
	}
	defer f.Close()
	if !dir {
		if e = setReadonly(f, false); e != nil {
			return e
		}
	}
	var remove uint32 = 1
	return windows.SetFileInformationByHandle(windows.Handle(f.Fd()), windows.FileDispositionInfo, (*byte)(unsafe.Pointer(&remove)), 4)
}
func isExists(e error) bool { return e == windows.STATUS_OBJECT_NAME_COLLISION }

func onlyDefaultStream(h windows.Handle) bool {
	var data [512]byte
	if windows.GetFileInformationByHandleEx(h, windows.FileStreamInfo, &data[0], uint32(len(data))) != nil {
		return false
	}
	if binary.LittleEndian.Uint32(data[:4]) != 0 || binary.LittleEndian.Uint32(data[4:8]) != 14 {
		return false
	}
	return string(data[24:38]) == ":\x00:\x00$\x00D\x00A\x00T\x00A\x00"
}
