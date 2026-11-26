// The Windows executable carries an isolated Python runtime and the CNC app.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
)

//go:embed payload.zip
var payload []byte

func unpack() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	cache = filepath.Join(cache, "ContourCNC")
	if err := os.MkdirAll(cache, 0700); err != nil {
		return "", err
	}
	digest := sha256.Sum256(payload)
	target := filepath.Join(cache, fmt.Sprintf("%x", digest[:12]))
	if _, err := os.Stat(filepath.Join(target, "python.exe")); err == nil {
		return target, nil
	}

	staging, err := os.MkdirTemp(cache, "extract-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(staging)
	bundle, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return "", err
	}
	for _, item := range bundle.File {
		name, err := filepath.Localize(item.Name)
		if err != nil {
			return "", err
		}
		path := filepath.Join(staging, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return "", err
		}
		in, err := item.Open()
		if err != nil {
			return "", err
		}
		out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			in.Close()
			return "", err
		}
		_, copyErr := io.Copy(out, in)
		closeErr := out.Close()
		in.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	if err := os.Rename(staging, target); err != nil {
		// A concurrent launch may have already extracted this exact payload.
		if _, statErr := os.Stat(filepath.Join(target, "python.exe")); statErr != nil {
			return "", err
		}
	}
	return target, nil
}

func run() error {
	root, err := unpack()
	if err != nil {
		return fmt.Errorf("unpacking Contour CNC: %w", err)
	}
	app := filepath.Join(root, "app", "app.py")
	args := append([]string{"-X", "utf8", "-B", "-u", app}, os.Args[1:]...)
	command := exec.Command(filepath.Join(root, "python.exe"), args...)
	command.Dir = root
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr

	// The Python child receives the same console Ctrl+C and closes the sender.
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	defer signal.Stop(interrupt)
	return command.Run()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Contour CNC:", err)
		if input, statErr := os.Stdin.Stat(); statErr == nil && input.Mode()&os.ModeCharDevice != 0 {
			fmt.Fprintln(os.Stderr, "Press Enter to close.")
			fmt.Scanln()
		}
		os.Exit(1)
	}
}
