package index

import (
	"sort"
	"testing"
)

// The server binary-searches the term dictionary with JavaScript's `<`, which
// compares UTF-16 code units. Go's own ordering is by code point, and the two
// part company above the BMP.
func TestLessUTF16MatchesJavaScriptOrder(t *testing.T) {
	// Pairs where code point order and UTF-16 order disagree: U+FF11 is one code
	// unit, U+11000 is a surrogate pair beginning 0xD804.
	if !lessUTF16("\U00011000", "１") {
		t.Error("an astral character must sort before U+FF11, as it does in JavaScript")
	}
	if lessUTF16("１", "\U00011000") {
		t.Error("U+FF11 must not sort before an astral character")
	}
	// Within one surrogate block the low unit decides, which is code point order.
	if !lessUTF16("\U00011000", "\U00011001") {
		t.Error("astral characters sharing a high surrogate sort by code point")
	}
	// Everything ASCII is unaffected.
	for _, c := range []struct{ a, b string }{
		{"a", "b"}, {"", "a"}, {"abc", "abd"}, {"ab", "abc"}, {"praha", "prahb"},
	} {
		if !lessUTF16(c.a, c.b) {
			t.Errorf("lessUTF16(%q, %q) = false", c.a, c.b)
		}
	}
	if lessUTF16("a", "a") {
		t.Error("equal strings are not less than each other")
	}
}

// The property the server actually depends on: sorted here, still sorted there.
func TestSortUTF16IsTotalAndStable(t *testing.T) {
	terms := []string{
		"１", "\U00011000", "praha", "\U0001F600", "", "a", "",
		"\U00011001", "z", "と", "münchen", "�",
	}
	sortUTF16(terms)
	if !sort.SliceIsSorted(terms, func(i, j int) bool { return lessUTF16(terms[i], terms[j]) }) {
		t.Fatalf("sortUTF16 left %v unsorted by its own comparator", terms)
	}
	// A dictionary must not hold two terms in an order the comparator calls equal
	// but that differ, or a binary search can miss one.
	for i := 1; i < len(terms); i++ {
		if terms[i] == terms[i-1] {
			continue
		}
		if !lessUTF16(terms[i-1], terms[i]) {
			t.Errorf("%q and %q are adjacent but not ordered", terms[i-1], terms[i])
		}
	}
}
