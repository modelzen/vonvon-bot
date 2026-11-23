package main

import (
	"errors"
	"golang.org/x/sys/windows"
)

func writerExcluded(e error) bool { return errors.Is(e, windows.ERROR_SHARING_VIOLATION) }
