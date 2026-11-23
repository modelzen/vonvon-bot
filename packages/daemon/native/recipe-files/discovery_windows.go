package main

import (
	"encoding/binary"
	"golang.org/x/sys/windows"
	"unicode/utf16"
)

func missingEntry(e error) bool {
	return e == windows.STATUS_OBJECT_NAME_NOT_FOUND || e == windows.STATUS_OBJECT_PATH_NOT_FOUND
}
func documentMetadata(parent *held, name string) (bool, bool) {
	file, e := ntOpen(parent.file, name, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN, windows.FILE_NON_DIRECTORY_FILE)
	if e != nil {
		return false, false
	}
	defer file.Close()
	m, e := inspect(file)
	regular := e == nil && !m.directory
	return regular && m.size <= fileCap, regular && m.size > fileCap
}

func listNames(dir *held, limit int) ([]string, error) {
	var buffer [16384]byte
	var names []string
	for {
		e := windows.GetFileInformationByHandleEx(windows.Handle(dir.file.Fd()), windows.FileFullDirectoryInfo, &buffer[0], uint32(len(buffer)))
		if e == windows.ERROR_NO_MORE_FILES {
			return names, nil
		}
		if e != nil {
			return nil, e
		}
		for cursor := 0; ; {
			if cursor+68 > len(buffer) {
				return nil, refused
			}
			length := int(binary.LittleEndian.Uint32(buffer[cursor+60:]))
			next := int(binary.LittleEndian.Uint32(buffer[cursor:]))
			if length < 2 || length%2 != 0 || length > len(buffer)-cursor-68 {
				return nil, refused
			}
			units := make([]uint16, length/2)
			for i := range units {
				units[i] = binary.LittleEndian.Uint16(buffer[cursor+68+i*2:])
			}
			name := string(utf16.Decode(units))
			if name != "." && name != ".." {
				names = append(names, name)
				if len(names) > limit {
					return nil, refused
				}
			}
			if next == 0 {
				break
			}
			if next < 68+length || next > len(buffer)-cursor {
				return nil, refused
			}
			cursor += next
		}
	}
}
