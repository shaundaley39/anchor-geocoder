// Writing typed arrays to disk. Every file in the artifact is a bare little-
// endian array with no header, so the server can map it straight into a
// TypedArray — the manifest carries what would otherwise be a header.

package index

import (
	"encoding/binary"
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
