# Phase 3 — BLA technical evaluation (Module 1: Shield Protect)

Evaluated: https://github.com/qybaihe/bla (read of the repository README and
metadata, 7 Nov 2026). This document is an evaluation only. **BLA is not
integrated.** No BLA code has been copied into this repository.

## What BLA is

"Blind LLM Agents" — a defensive hardening tool aimed at AI reverse-engineering
agents. Its self-described method is Poison → Exhaust → Hallucinate: plant
format-valid canaries and honey metadata, push the analyser past its documented
resource budgets, and leave it with truncated or ambiguous inventories while the
artifact's runtime behaviour stays equivalent. Distributed as a CLI and an MCP
server (`npx bla-agents`, npm package `bla-agents`), with `harden` / `audit` /
`protect` / `verify` / `defend` stages.

## License

MIT (repository license and topic list confirm MIT). MIT requires the copyright
notice and permission text to travel with any substantial portion of the code, so
any integration must ship `LICENSES/BLA-MIT.txt` and a notice in the docs and the
about/credits surface. The project also ships `DISCLAIMER.md` restricting use to
software you own or are authorised to protect — which matches the product rule we
intend to enforce anyway.

## Architecture and runtime

- TypeScript, Node-based CLI plus MCP server and an agent skill.
- Node `^22.23.4` or `24.x` recommended (REA red-team paths need `zlib.zstd`).
- Operates on build artifacts and project directories: it auto-discovers `dist/`,
  `build/`, `.asar`, `.wasm`, `.sqlite`, model files.
- Long CPU-bound passes over large artifacts; several formats need optional native
  tooling (Wabt, tshark) and the native-tool paths (Ghidra, Frida, LLDB, Rizin,
  JADX, firmware, GPU objects) are explicitly **not** empirically verified upstream.
- No APK resigning; DEX shield exists but the full Android pipeline does not.

## Format coverage (as published)

Verified upstream against a synthetic REA: JavaScript/TypeScript, Electron `.asar`,
Electron fuses, WASM (with Wabt), SQLite, Safetensors, GGUF, Go build-info, BEAM,
EVM bytecode, PCAP, Flutter asset pools, Python/.pyc. Designed but unverified:
native binaries (Ghidra), live debugger sessions, Android APK, firmware, SPIR-V/CUDA.

## What it actually buys us

Protection is **cost inflation, not impossibility**: it raises the analyser's token
and time cost and lowers the quality of what it extracts. Nothing here prevents a
determined human with the right tooling. Our product copy must say exactly that,
and the UI must label every artifact's protection as "verified equivalent runtime"
plus the engine version, never "unreverse-engineerable".

## Fit with our architecture

| Dimension | Assessment |
| --- | --- |
| Language/runtime | Compatible (Node 22+, same as this app) |
| Deployment model | **Blocker.** Render free tier: 512 MB, ephemeral disk, long CPU work per upload. BLA hardening is memory- and CPU-heavy and writes large outputs. |
| Isolation | Must run out-of-process in a sandboxed worker with wall-clock and size limits; in-process use would stall the API. |
| Artifact handling | Needs upload validation (type, size), archive traversal guards, preserved original, separate output. All new surface for us. |
| Interaction with Module 2 | None. It must stay a separate service boundary (`src/protect/*`) with its own tables. |
| Attribution | MIT notice required if any code is vendored; preferably call the CLI as a dependency instead of vendoring. |

## Decision

Do **not** vendor BLA now. Implement the boundary and the contract first:

1. `POST /api/workspaces/:w/protections` — declare an artifact (name, format, size,
   owner attestation) → job row.
2. Upload with validation: extension allow-list, max bytes, no archive extraction
   without traversal-safe unpacking.
3. A worker that, when BLA is available, shells out to `bla-agents harden <dir>`
   with a timeout and a memory cap, captures stdout/stderr and the produced
   artifact, then runs `verify` to assert runtime equivalence.
4. Store `engine`, `engine_version`, `format`, `supported`, `verification`
   (`equivalent | failed | not_run`) and never a claim stronger than that.
5. Feature-flagged off until the worker exists; the UI shows "not available on this
   deployment" rather than pretending.

Exact blockers to lift before real integration: a host with persistent disk and
more than 512 MB RAM (or a container job runner), BLA's own license notice added,
and a controlled test artifact with a known-good runtime check.
