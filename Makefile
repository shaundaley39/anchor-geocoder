# Geocoding pipeline: Go ingest -> binary index artifact -> TypeScript API.
# `make all` reproduces everything from nothing.

RAW      := data/raw
BUILD    := build
# The contiguous central-European block. Override for a smaller build:
#   make records COUNTRIES=cz,sk
COUNTRIES ?= de,pl,it,nl,cz,at,be,ch,dk,sk,hu,hr,ba,lu
GO       := GOTOOLCHAIN=local CGO_ENABLED=0 go

CZ_PBF := $(RAW)/czech-republic-latest.osm.pbf
GEOFABRIK := https://download.geofabrik.de/europe

.PHONY: all fetch records index test test-go test-server clean verify \
        fold-vectors serve bench install docker docker-bundled docker-run \
        docker-run-bundled

all: fetch records index

comma := ,

# Map the COUNTRIES list onto extract filenames so `make fetch COUNTRIES=cz`
# downloads only what that build will actually read.
slug-cz := czech-republic
slug-pl := poland
slug-ba := bosnia-herzegovina
slug-de := germany
slug-it := italy
slug-nl := netherlands
slug-at := austria
slug-be := belgium
slug-ch := switzerland
slug-dk := denmark
slug-sk := slovakia
slug-hu := hungary
slug-hr := croatia
slug-lu := luxembourg
cc-file = $(RAW)/$(slug-$(strip $1))-latest.osm.pbf
## fetch: download and checksum the extracts named by COUNTRIES (default cz,pl)
fetch: $(foreach c,$(subst $(comma), ,$(COUNTRIES)),$(call cc-file,$c))

$(RAW)/%-latest.osm.pbf:
	@mkdir -p $(RAW)
	curl -fSL --retry 3 -C - -o $@ $(GEOFABRIK)/$*-latest.osm.pbf
	curl -fsSL -o $@.md5 $(GEOFABRIK)/$*-latest.osm.pbf.md5
	@cd $(RAW) && test "$$(awk '{print $$1}' $*-latest.osm.pbf.md5)" = \
	   "$$(md5 -q $*-latest.osm.pbf 2>/dev/null || md5sum $*-latest.osm.pbf | cut -d' ' -f1)" \
	   && echo "  checksum OK: $*" || (echo "  CHECKSUM MISMATCH: $*" && exit 1)

## records: extract OSM into the normalized record stream (build/records.ndjson.gz)
records:
	@mkdir -p $(BUILD)
	cd ingest && $(GO) run ./cmd/geoingest -countries $(COUNTRIES) -raw ../$(RAW) -out ../$(BUILD)

## index: turn the record stream into the binary artifact the server loads
index:
	cd ingest && $(GO) run ./cmd/geoindex -in ../$(BUILD)/records.ndjson.gz -out ../$(BUILD)/index

## fold-vectors: regenerate the Go->TS normalization contract fixtures
fold-vectors:
	cd ingest && $(GO) run ./cmd/foldvectors \
	  -in ../$(BUILD)/records.ndjson.gz -out ../server/test/fold-vectors.json

## install: install server dependencies
install:
	cd server && pnpm install

## serve: run the API server (INDEX_DIR, PORT, HOST are overridable)
serve:
	cd server && INDEX_DIR=../$(BUILD)/index pnpm exec tsx src/index.ts

## bench: measure query latency against the built index
bench:
	cd server && pnpm exec tsx bench.mts

## test: run both test suites
test: test-go test-server

test-go:
	cd ingest && $(GO) test ./...

test-server:
	cd server && pnpm exec vitest run

## verify: report what the tag distribution in an extract actually looks like
verify:
	cd ingest && $(GO) run ./cmd/tagstat -f ../$(CZ_PBF)

# ---------------------------------------------------------------- docker ----
IMAGE ?= anchor-geocoder

## docker: slim image; the index is mounted at run time
docker:
	docker build --target runtime -t $(IMAGE):slim .

## docker-bundled: self-contained image with the index baked in (needs `make index`)
docker-bundled: $(BUILD)/index/manifest.json
	docker build --target bundled -t $(IMAGE):bundled .

$(BUILD)/index/manifest.json:
	@echo "no index at $(BUILD)/index — run 'make index' first" && exit 1

## docker-run: run the slim image with the local index mounted read-only
docker-run: docker
	docker run --rm -p 3000:3000 -v "$(PWD)/$(BUILD)/index:/index:ro" $(IMAGE):slim

## docker-run-bundled: run the self-contained image, no volume
docker-run-bundled: docker-bundled
	docker run --rm -p 3000:3000 $(IMAGE):bundled

clean:
	rm -rf $(BUILD)

## show-fetch: print which extracts COUNTRIES resolves to (debugging the Makefile)
show-fetch:
	@echo $(foreach c,$(subst $(comma), ,$(COUNTRIES)),$(call cc-file,$c))
