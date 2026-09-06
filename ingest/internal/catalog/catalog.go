// Package catalog reads the country and group definitions.
//
// They live in config/*.tsv, not Go source, because the Makefile needs them too
// — duplicating the list is how a country ends up fetchable but not ingestable.
// TSV so awk reads it as easily as Go. Adding a country is one line.
package catalog

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Country is one ingestable extract.
type Country struct {
	Code string // ISO 3166-1 alpha-2 where one exists
	Path string // Geofabrik path, relative to the download root
	Name string
	Size int64 // indicative bytes, from the daily rebuild
}

// Filename is the last path component of the URL.
func (c Country) Filename() string {
	return filepath.Base(c.Path) + "-latest.osm.pbf"
}

// URL is where the extract is fetched from.
func (c Country) URL() string {
	return "https://download.geofabrik.de/" + c.Path + "-latest.osm.pbf"
}

// Catalog is the parsed configuration.
type Catalog struct {
	Countries map[string]Country
	Groups    map[string][]string
}

// Load reads countries.tsv and groups.tsv from dir.
func Load(dir string) (*Catalog, error) {
	c := &Catalog{Countries: map[string]Country{}, Groups: map[string][]string{}}

	if err := eachRow(filepath.Join(dir, "countries.tsv"), 4, func(f []string) error {
		size, _ := strconv.ParseInt(f[2], 10, 64)
		c.Countries[f[0]] = Country{Code: f[0], Path: f[1], Size: size, Name: f[3]}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := eachRow(filepath.Join(dir, "groups.tsv"), 2, func(f []string) error {
		c.Groups[f[0]] = strings.Split(f[1], ",")
		return nil
	}); err != nil {
		return nil, err
	}
	return c, nil
}

func eachRow(path string, want int, fn func([]string) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	line := 0
	for sc.Scan() {
		line++
		t := sc.Text()
		if strings.TrimSpace(t) == "" || strings.HasPrefix(t, "#") {
			continue
		}
		fields := strings.Split(t, "\t")
		if len(fields) < want {
			return fmt.Errorf("%s:%d: want %d tab-separated fields, got %d",
				path, line, want, len(fields))
		}
		if err := fn(fields); err != nil {
			return err
		}
	}
	return sc.Err()
}

// Resolve expands a selection into country codes, in order, deduplicated. An
// entry prefixed with @ names a group; groups do not nest, which keeps the file
// readable and the errors obvious.
func (c *Catalog) Resolve(selection string) ([]string, error) {
	var out []string
	seen := map[string]bool{}

	for _, raw := range strings.Split(selection, ",") {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		codes := []string{item}
		if strings.HasPrefix(item, "@") {
			g, ok := c.Groups[item[1:]]
			if !ok {
				return nil, fmt.Errorf("unknown group %q (known: %s)",
					item, strings.Join(c.groupNames(), ", "))
			}
			codes = g
		}
		for _, code := range codes {
			code = strings.TrimSpace(code)
			if code == "" || seen[code] {
				continue
			}
			if _, ok := c.Countries[code]; !ok {
				return nil, fmt.Errorf("unknown country %q (known: %s)",
					code, strings.Join(c.codes(), ", "))
			}
			seen[code] = true
			out = append(out, code)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("selection %q resolved to no countries", selection)
	}
	return out, nil
}

func (c *Catalog) codes() []string {
	out := make([]string, 0, len(c.Countries))
	for k := range c.Countries {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (c *Catalog) groupNames() []string {
	out := make([]string, 0, len(c.Groups))
	for k := range c.Groups {
		out = append(out, "@"+k)
	}
	sort.Strings(out)
	return out
}
