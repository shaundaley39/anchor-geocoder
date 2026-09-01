# Geocoding pipeline. The ingest stage is Go; the serving stage (next) is
# TypeScript. `make all` reproduces the index artifact from nothing.

RAW      := data/raw
BUILD    := build
COUNTRIES?= cz,pl
GO       := GOTOOLCHAIN=local CGO_ENABLED=0 go

CZ_PBF := $(RAW)/czech-republic-latest.osm.pbf
PL_PBF := $(RAW)/poland-latest.osm.pbf
BA_PBF := $(RAW)/bosnia-herzegovina-latest.osm.pbf
GEOFABRIK := https://download.geofabrik.de/europe

.PHONY: all fetch build test clean fetch-ba verify

all: fetch build

## fetch: download and checksum the OSM extracts
fetch: $(CZ_PBF) $(PL_PBF)

$(RAW)/%-latest.osm.pbf:
	@mkdir -p $(RAW)
	curl -fSL --retry 3 -C - -o $@ $(GEOFABRIK)/$*-latest.osm.pbf
	curl -fsSL -o $@.md5 $(GEOFABRIK)/$*-latest.osm.pbf.md5
	@cd $(RAW) && test "$$(awk '{print $$1}' $*-latest.osm.pbf.md5)" = \
	   "$$(md5 -q $*-latest.osm.pbf 2>/dev/null || md5sum $*-latest.osm.pbf | cut -d' ' -f1)" \
	   && echo "  checksum OK: $*" || (echo "  CHECKSUM MISMATCH: $*" && exit 1)

## fetch-ba: Bosnia is an optional third country
fetch-ba: $(BA_PBF)

## build: run the Go ingest over the extracts, producing build/records.ndjson.gz
build:
	@mkdir -p $(BUILD)
	cd ingest && $(GO) run ./cmd/geoingest -countries $(COUNTRIES) -raw ../$(RAW) -out ../$(BUILD)

## test: run the Go test suite
test:
	cd ingest && $(GO) test ./...

## verify: report what the tag distribution in an extract actually looks like
verify:
	cd ingest && $(GO) run ./cmd/tagstat -f ../$(CZ_PBF)

clean:
	rm -rf $(BUILD)
