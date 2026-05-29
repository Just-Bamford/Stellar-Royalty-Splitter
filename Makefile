# Stellar Royalty Splitter — build / optimise / clean (#285).
#
# Adds an explicit `wasm-opt -Oz` step to the build pipeline so the
# deployed wasm has a smaller footprint (lower ledger fees on every
# invocation). The existing `scripts/deploy.sh` uses
# `stellar contract optimize`, but that conflates build + deploy; CI
# wants a `make build` target that runs the optimization pass without
# touching the network, which this Makefile provides.

CONTRACT_NAME := stellar_royalty_splitter
TARGET_DIR    := target/wasm32-unknown-unknown/release
RAW_WASM      := $(TARGET_DIR)/$(CONTRACT_NAME).wasm
OPT_WASM      := $(TARGET_DIR)/$(CONTRACT_NAME).optimized.wasm

# Detect a wasm-opt binary. Falls back to `stellar contract optimize`
# (which embeds wasm-opt) when the standalone binary isn't installed.
WASM_OPT      := $(shell command -v wasm-opt 2>/dev/null)

.PHONY: all build optimize clean check-size deploy-ready

all: optimize

## Build the contract in release mode.
build:
	cargo build --target wasm32-unknown-unknown --release

## Run `wasm-opt -Oz` on the release artifact. Falls back to the
## Stellar CLI's bundled optimizer when wasm-opt isn't installed
## locally, so the target works in dev + CI even when the binary
## hasn't been provisioned.
optimize: build
	@echo "▶ Optimising $(RAW_WASM)"
ifeq ($(WASM_OPT),)
	@echo "wasm-opt not on PATH; falling back to 'stellar contract optimize'"
	stellar contract optimize --wasm $(RAW_WASM)
else
	$(WASM_OPT) -Oz $(RAW_WASM) -o $(OPT_WASM)
endif
	@echo "▶ Done: $(OPT_WASM)"

## Report the raw and optimised sizes so CI can fail when the
## optimisation regresses (e.g. someone adds a panic path).
check-size: optimize
	@echo "▶ Raw      : $$(wc -c < $(RAW_WASM)) bytes"
	@echo "▶ Optimised: $$(wc -c < $(OPT_WASM)) bytes"

## Make sure the optimised artifact exists; useful as a CI gate
## before `scripts/deploy.sh`.
deploy-ready: optimize
	@test -f $(OPT_WASM) || { echo "Optimised wasm missing"; exit 1; }
	@echo "▶ Ready to deploy: $(OPT_WASM)"

clean:
	cargo clean
