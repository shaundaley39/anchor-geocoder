// Writing typed arrays to disk. Every file in the artifact is a bare little-
// endian array with no header, so the server can map it straight into a
// TypedArray — the manifest carries what would otherwise be a header.

package index

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
)

func writeAll(dir string, files map[string]any, man *Manifest) error {
	names := make([]string, 0, len(files))
	for k := range files {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, name := range names {
		var err error
		var n int
		switch v := files[name].(type) {
		case []uint32:
			n, err = 4*len(v), writeU32(dir, name+".bin", v)
		case []int32:
			n, err = 4*len(v), writeI32(dir, name+".bin", v)
		case []float32:
			n, err = 4*len(v), writeF32(dir, name+".bin", v)
		case []byte:
			n, err = len(v), os.WriteFile(filepath.Join(dir, name+".bin"), v, 0o644)
		}
		if err != nil {
			return err
		}
		man.Bytes[name] = n
	}
	return nil
}

func writeU32(dir, name string, v []uint32) error {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], x)
	}
	return os.WriteFile(filepath.Join(dir, name), buf, 0o644)
}

func writeI32(dir, name string, v []int32) error {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], uint32(x))
	}
	return os.WriteFile(filepath.Join(dir, name), buf, 0o644)
}

func writeF32(dir, name string, v []float32) error {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], math.Float32bits(x))
	}
	return os.WriteFile(filepath.Join(dir, name), buf, 0o644)
}

// A column written straight to disk rather than built in memory first.
//
// Every array here is written once, in order, and then never touched — but
// building them as slices meant holding all nineteen anchor columns at once,
// 1.5GB for Europe, on top of the anchors they were copied from. Streaming
// costs a buffer.
type col struct {
	f   *os.File
	w   *bufio.Writer
	buf [4]byte
	n   int
}

func newCol(dir, name string) (*col, error) {
	f, err := os.Create(filepath.Join(dir, name+".bin"))
	if err != nil {
		return nil, err
	}
	return &col{f: f, w: bufio.NewWriterSize(f, 1<<20)}, nil
}

func (c *col) u32(v uint32) {
	binary.LittleEndian.PutUint32(c.buf[:], v)
	_, _ = c.w.Write(c.buf[:])
	c.n += 4
}

func (c *col) i32(v int32) { c.u32(uint32(v)) }

func (c *col) f32(v float32) { c.u32(math.Float32bits(v)) }

func (c *col) u8(v byte) {
	_ = c.w.WriteByte(v)
	c.n++
}

// close flushes and reports the bytes written; errors surface here rather than
// per value, since a short write only shows up at the end.
func (c *col) close() (int, error) {
	if err := c.w.Flush(); err != nil {
		_ = c.f.Close()
		return 0, err
	}
	if err := c.f.Close(); err != nil {
		return 0, err
	}
	return c.n, nil
}

// writeCol streams one file: `fill` is called once per entry, in order.
func writeCol(dir, name string, man *Manifest, n int, fill func(c *col, i int)) error {
	c, err := newCol(dir, name)
	if err != nil {
		return err
	}
	for i := 0; i < n; i++ {
		fill(c, i)
	}
	written, err := c.close()
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	man.Bytes[name] = written
	return nil
}
