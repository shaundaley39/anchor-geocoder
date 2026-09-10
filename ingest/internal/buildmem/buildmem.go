// Package buildmem keeps the build inside the memory it is given.
//
// Both halves of the pipeline hold most of a continent in RAM at some point, so
// both want the same two things: a way to say how much memory there is, and a
// way to see where it went.
package buildmem

import (
	"log"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
)

// LogMem reports the live heap at a phase boundary. The build is the
// memory-hungry half of this project, and the only way to keep it honest about
// that is to say so as it goes.
func Log(phase string) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	log.Printf("  mem %-22s live %5.1f GB  heap %5.1f GB  from os %5.1f GB",
		phase, float64(m.HeapAlloc)/1e9, float64(m.HeapSys)/1e9, float64(m.Sys)/1e9)
}

// SetLimit puts a soft ceiling on the heap, from BUILD_MEM_GB.
//
// Go's collector runs when the heap has doubled since the last collection, so
// peak resident memory is roughly twice what is live — for Europe, 14 GB live
// and 28 GB resident. A soft limit inverts that: as the heap approaches the
// ceiling the collector runs harder, trading CPU for the memory the machine
// does not have. Nothing is refused, so an honest overshoot still completes,
// just slowly, rather than being OOM-killed at the last pass.
//
// Off by default: on a machine with room, the default collector is faster and
// the memory is free. GOMEMLIMIT works too; this exists so the Makefile can set
// it in gigabytes without spelling out a byte count.
func SetLimit() {
	v := os.Getenv("BUILD_MEM_GB")
	if v == "" {
		return
	}
	gb, err := strconv.ParseFloat(v, 64)
	if err != nil || gb <= 0 {
		log.Fatalf("BUILD_MEM_GB=%q is not a positive number of gigabytes", v)
	}
	// A tenth held back for what the runtime allocates outside the heap: stacks,
	// the page allocator's own bookkeeping, and the gzip and json buffers.
	limit := int64(gb * 0.9 * (1 << 30))
	debug.SetMemoryLimit(limit)
	log.Printf("heap limited to %.1f GB of %.1f GB; the collector will work harder near it",
		float64(limit)/(1<<30), gb)
}
