# Geocoding pipeline: Go ingest -> binary index artifact -> TypeScript API.
# `make all` reproduces everything from nothing.

RAW      := data/raw
BUILD    := build
# A four-country default that anyone can build: ~3.5GB of extracts, ~14M
# addresses, under four minutes.
#
#   make countries                     list everything available
#   make all COUNTRIES=cz              one country, ~90 seconds
#   make all COUNTRIES=@nordics        a named group
#   make all COUNTRIES=@europe         all 41, ~30GB of extracts
COUNTRIES ?= @default
GO       := GOTOOLCHAIN=local CGO_ENABLED=0 go

CZ_PBF := $(RAW)/czech-republic-latest.osm.pbf

.PHONY: all fetch records index test test-go test-server clean verify countries \
        fold-vectors serve bench install docker docker-bundled docker-run \
        docker-run-bundled hooks lint lint-go lint-server fixtures format-constants

all: fetch records index

# Map the COUNTRIES list onto extract filenames so `make fetch COUNTRIES=cz`
# downloads only what that build will actually read.
# Country definitions come from config/countries.tsv, the same file the Go build
# reads. There is deliberately no second list here: a country fetchable but not
# ingestable, or the reverse, is exactly what duplication produces.
CATALOG := config/countries.tsv
RESOLVE := scripts/resolve-countries.sh

PBFS := $(addprefix $(RAW)/,$(shell $(RESOLVE) files "$(COUNTRIES)"))

## fetch: download and checksum the extracts named by COUNTRIES (default cz,pl)
fetch: $(PBFS)

# The download path may sit in a subdirectory (europe/great-britain) while the
# local file is flat, so the URL is looked up rather than derived from the name.
$(RAW)/%-latest.osm.pbf:
	@mkdir -p $(RAW)
	@url=$$($(RESOLVE) url "$*"); \
	 test -n "$$url" || { echo "no catalog entry for $*"; exit 1; }; \
	 curl -fSL --retry 3 -C - -o $@ "$$url"; \
	 curl -fsSL -o $@.md5 "$$url.md5"
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

## fixtures: regenerate the cross-language contract fixtures
fixtures: fold-vectors format-constants

fold-vectors:
	cd ingest && $(GO) run ./cmd/foldvectors \
	  -in ../$(BUILD)/records.ndjson.gz -out ../server/test/fold-vectors.json

format-constants:
	cd ingest && $(GO) run ./cmd/formatconsts -out ../server/test/format-constants.json

## install: install server dependencies
install:
	cd server && pnpm install

## serve: run the API server (INDEX_DIR, PORT, HOST are overridable)
serve:
	cd server && INDEX_DIR=../$(BUILD)/index pnpm exec tsx src/index.ts

## bench: measure query latency against the built index
bench:
	cd server && pnpm exec tsx bench.mts

## hooks: install the local git hooks (fast static checks, no tests)
hooks:
	@git config core.hooksPath scripts/hooks
	@echo "  hooks installed from scripts/hooks (bypass once with -n / --no-verify)"

## lint: the same checks CI runs
lint: lint-go lint-server

lint-go:
	cd ingest && $(GO) vet ./...
	@cd ingest && u=$$(gofmt -l .); test -z "$$u" || (echo "not gofmt'd:"; echo "$$u"; exit 1)
	@command -v golangci-lint >/dev/null && (cd ingest && CGO_ENABLED=0 golangci-lint run ./...) \
	  || echo "  golangci-lint not installed; skipped (brew install golangci-lint)"

lint-server:
	cd server && pnpm exec tsc --noEmit -p tsconfig.test.json
	cd server && pnpm exec eslint .

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

## countries: list everything the pipeline can ingest, and the named groups
countries:
	@awk -F'\t' '!/^#/ && NF>=4 {printf "  %-4s %-34s %6.2f GB\n", $$1, $$4, $$3/1073741824}' $(CATALOG)
	@echo ""
	@awk -F'\t' '!/^#/ && NF>=2 {printf "  @%-14s %s\n", $$1, $$2}' config/groups.tsv

## show-fetch: print what COUNTRIES resolves to, without downloading anything
show-fetch:
	@echo "  codes: $$($(RESOLVE) codes "$(COUNTRIES)")"
	@echo "  size:  $$($(RESOLVE) size "$(COUNTRIES)") GB of extracts"
