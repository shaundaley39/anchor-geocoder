// The string dictionary. Every repeated name, locality and category in the
// corpus is stored once and referenced by id, which is most of why the artifact
// fits in memory.

package index

import (
	"os"
	"path/filepath"
)

// AltSep joins alternate names inside one interned string; U+001F cannot occur
// in an OSM name.
const AltSep = "\x1f"

// StringTable interns strings, assigning each a stable id.
type StringTable struct {
	ids  map[string]uint32
	list []string
}

func NewStringTable() *StringTable {
	t := &StringTable{ids: map[string]uint32{}}
	t.Intern("") // id 0 is always the empty string, so 0 reads as "absent"
	return t
}

func (t *StringTable) Intern(s string) uint32 {
	if id, ok := t.ids[s]; ok {
		return id
	}
	id := uint32(len(t.list))
	t.ids[s] = id
	t.list = append(t.list, s)
	return id
}

func (t *StringTable) Len() int { return len(t.list) }

// Get returns the interned string for an id.
func (t *StringTable) Get(id uint32) string {
	if int(id) >= len(t.list) {
		return ""
	}
	return t.list[id]
}

// Write emits the blob and its offset table.
func (t *StringTable) Write(dir, base string) (int, error) {
	var blob []byte
	offs := make([]uint32, len(t.list)+1)
	for i, s := range t.list {
		offs[i] = uint32(len(blob))
		blob = append(blob, s...)
	}
	offs[len(t.list)] = uint32(len(blob))

	if err := os.WriteFile(filepath.Join(dir, base+".bin"), blob, 0o644); err != nil {
		return 0, err
	}
	if err := writeU32(dir, base+".idx", offs); err != nil {
		return 0, err
	}
	return len(blob) + 4*len(offs), nil
}
