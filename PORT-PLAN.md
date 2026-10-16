# Port plan: fork 0.59.2 → upstream 0.83.5

Branch `port-0.83` (worktree `C:\Users\blakm\koharu-port`).
Production fork stays untouched at `C:\Users\blakm\koharu` (`website-integration`, 0.59.2 + 38 commits).

## 1. What upstream did

`0.63.0` (2026-08-11) rebuilt the application. Between our base and 0.83.5 there are
551 commits including `refactor: rebuild Koharu application and ML architecture`,
`refactor: rebuild scene graph`, `refactor: integrate canvas, storage, renderer, and desktop`.

Consequences for us:

| | 0.59.2 | 0.83.5 |
|---|---|---|
| Layout | `koharu-*/`, `ui/` | `crates/*`, `packages/{koharu,ui,bridge,docs}` |
| UI↔Rust boundary | **HTTP RPC** (`koharu-rpc`, :4000) | **Tauri IPC commands** (`koharu-app/src/commands/*`) |
| LLM crate | `koharu-llm` | `koharu-translator` |
| Rendering | native | `koharu-canvas` WASM + WebGPU |
| License | GPL-3.0 | Apache-2.0 OR MIT |
| Repo | mayocream/koharu | koharu-rs/koharu |

`koharu-rpc` and `koharu-llm` no longer exist. There is **no HTTP server anywhere** in
0.83.5 (`axum::Router` appears zero times). Every endpoint our automation calls is gone:
`/api/v1/{config,ext/token,llm/catalog,llm/current,operations,scene}`, `/pages/`.

Upstream's new `koharu-agent` is a Codex coding-agent integration (`codex/auth.rs`,
`token_store.rs`, `tool.rs`) — unrelated to our translation agent. It does not replace our work.

## 2. What upstream now gives us for free

- `koharu-pipeline/src/bin/run.rs` — headless CLI for the whole pipeline:
  `--input --output --detection --ocr --inpainting --target-language --llm --cpu`
  and **`--translation-instructions`**, which is exactly the glossary/system-prompt
  injection point we hand-rolled in `koharu-llm/src/prompt.rs`.
- `koharu-translator/src/remote/openai_compatible.rs` with configurable `base_url`
  + `koharu_secrets` — our shared llama.cpp server is a first-class provider.
- Structured JSON translation output (segment ids, `ResponseFormat`/`JsonSchema`).
  This likely obsoletes fork commits 4, 33, 34 (prompt-shortening, target-language-only,
  Western digits) — verify before porting them.
- OCR choices incl. `paddleocr-vl-1.6`, inpainting incl. `flux2-klein`.

## 3. Integration design (the decision this plan rests on)

Our agent is ~928 lines of TypeScript running **inside the webview**, which drives the app
through its own local HTTP API. In 0.83.5 that API is Tauri IPC. So:

**Layer 1 — agent stays in the webview, swap transport.**
`fetch('/api/v1/...')` → `invoke('...')`. Our RPC routes become fork-owned Tauri commands
in `crates/koharu-app/src/commands/` (new files, not edits to upstream ones — keeps future
rebases cheap).

**Layer 2 — a minimal control shim for external scripts.**
`restart-koharu-server.ps1` and `koharu-keepalive.ps1` live outside the app and need
readiness + model pinning. Add a fork-only crate exposing exactly:
`GET /health`, `GET /llm/current`, `PUT /llm/current`.
**Bind to :4100, not :4000** — upstream debug builds now use :4000 for the CEF remote
debugging endpoint.

**Layer 3 (optional, later) — headless farm via `koharu-pipeline run`.**
Could replace much of the agent for the 24/7 batch machine. Not required for parity;
revisit once Layers 1–2 are green.

## 4. Work groups

38 fork commits → 8 groups.

| # | Group | Commits | From → To | Effort |
|---|---|---|---|---|
| D | Prompt / LLM tuning | 1, 4, 33, 34 | `koharu-llm/prompt.rs`, `providers/*` → `--translation-instructions` + `koharu-translator` config | **S** — mostly deleted, upstream covers it |
| G | Tray / rebrand | 16, 21, 24 | `koharu/src/app.rs`, `tauri.conf.json`, icons → `crates/koharu`, `crates/koharu-desktop` | **S** |
| C | Glossary 2-way sync | 2, 19, 22 | `GlossaryDialog`, `glossaryStore` → `packages/koharu` + Layer 1 | **M** |
| A | Website auth / RBAC | 5, 6, 8, 9, 12, 13, 17 | `website.ts`, `authStore`, `AuthGate`, `LoginScreen`, `WebsiteDialog`, `routes/ext.rs` → `packages/koharu` + Layer 1 | **M** |
| F | Website RPC additions | 11, 18, 26, 28 | `routes/pages.rs`, `binary.rs` → new Tauri commands | **M** |
| E | khrproj-as-master | 27, 30, 31, 32 | `routes/projects.rs`, `io/scene.ts` → new Tauri commands + new scene API | **L** — scene graph rebuilt |
| H | Editor UX / perf | 3, 23, 25, 29 | `ui/components/*`, `usePrefetchPageBlobs` → `packages/koharu/components` | **L** — canvas is WASM/WebGPU now |
| B | Agent / batch | 7, 10, 14, 15, 20, 35, 36, 37, 38 | `websiteAgent.ts` (928 l), `AgentPanel` → `packages/koharu/lib` + Layer 1 | **L** — the core; port last, on top of A/C/F |

## 5. Order

1. **Layer 2 shim** + `restart-koharu-server.ps1` port change → proves the new build is drivable.
2. **G** (tray/rebrand) → the server instance can run headless again.
3. **D** → translation quality parity (glossary via `--translation-instructions`).
4. **B, reduced scope** → the farm runs again.
5. **C → A → F** → glossary, then the website hand-off for human editors.
6. **E → H** → khrproj master and editor parity.

B moved ahead of A/C/F on 2026-10-16: the farm is not running at all (the 0.59.2 instance is
stopped and the official 0.83.5 build has no website agent), so restoring unattended
translation outranks making the editor pleasant. The reduced scope is:

| # | piece | where |
|---|---|---|
| 1 | headless `import` / `export` and a website-token store, as fork-only commands | new `crates/koharu-app/src/commands/farm.rs` |
| 2 | `ui/lib/website.ts` → the new frontend (plain `fetch` against manga-th.net, nearly unchanged) | `packages/koharu/lib` |
| 3 | `ui/lib/websiteAgent.ts` (36 KB) rewritten against `@koharu/bridge` instead of fetch + the generated OpenAPI client | `packages/koharu/lib` |
| 4 | a minimal agent panel: start, stop, status | `packages/koharu/components` |
| 5 | `koharu-keepalive.ps1` → `ops/`, probing `:4100/health` | `ops/` |

Most of the command surface the agent needs already exists upstream: `create_project`,
`open_project`, `process`, `get_pages`, `get_page`, `set_translation`, `set_source_text`,
`add_text_box`, `get_translation_models`, and `subscribe`, whose `Channel<Job>` **pushes**
job state instead of being polled — that removes the stall class fixed by fork commits 36
and 37 rather than porting it. Deferred out of this scope: khrproj export-to-URL (E),
`WebsiteDialog` and the RBAC UI (A), `GlossaryDialog` (C).

## 6. Risks

- **Scene graph rewrite (E, H).** Our khrproj master format and text-node injection assume the
  old scene JSON. Expect redesign, not translation of code.
- **`:4000` collision** with CEF devtools in debug builds.
- **No backward compatibility upstream** (stated policy in `AGENTS.md`) — pin to 0.83.5 and
  expect the same class of break on the next major refactor.
- **Build toolchain** — resolved. 0.83.5 provisions its own ROCm SDK for `gfx1032` under the
  runtime store and ships a HIP libtorch, so the 0.59.2 fork's CUDA environment and its ZLUDA
  shim are both dead weight. Only `LIBCLANG_PATH` is needed.
- **`import` and `export` open native file dialogs** (`rfd::AsyncFileDialog` in
  `commands/lifecycle.rs` and `commands/output.rs`); `PageImportSource` is `Files | Folder`
  only. There is no way to feed pages in or get rendered pages out over IPC, so an unattended
  agent cannot drive 0.83.5 as shipped. Headless equivalents are the first piece of group B,
  modelled on `koharu-pipeline/src/bin/run.rs`, which does both without a dialog.
- **Command-name collision.** Upstream already has `run_agent`, `cancel_agent`,
  `login_agent`, `get_agent_status` — those belong to its Codex integration, not to our
  translation agent. Fork commands need their own prefix.
- GPL→Apache/MIT relicense is permissive-ward, so no new obligation on our side; our own
  files can keep whatever header we choose.

## 7. GPU budget (measured 2026-10-16)

The farm box is an AMD RX 6650 XT, 8,176 MiB, `gfx1032`. Measured per stage by running the
per-model binaries in `crates/koharu-ml/src/bin/` one process at a time against a real
1080×1531 raw page, sampling `\GPU Adapter Memory(*)\Dedicated Usage` at ~70 ms:

| phase | peak over baseline |
|---|---|
| `koharu_ml::init()` — Torch + Llama + Diffusion + ROCm | **0 MB** (8.3 s, never touches the GPU) |
| detection weights loading | ~480 MB |
| **detection inference** | **5,693 MB** |
| `hayai-ocr`, one 64×262 crop | 947 MB |
| `lama`, one page, five regions | 3,038 MB |

Detection alone takes 70 % of the card. `RESOLUTION 1152 / PATCH_SIZE 12` gives 9,216 tokens
and layers 3, 6, 9 and 12 run full attention, so one attention matrix is
6 heads × 9216² × 4 B = **2.04 GB** in fp32 — and this libtorch build warns that it was not
compiled with memory-efficient attention, so the whole matrix is materialised.

Consequences for the plan:

- **One pipeline per machine.** Scale by adding machines, not instances. `docs/PRD-worker-farm.md`
  assumes N koharu instances per host; that part of it is wrong for this hardware.
- **Group B must recycle the process** every N chapters. The caching allocator never returns
  freed blocks — `empty_cache` appears nowhere in the workspace and `koharu-torch` does not
  bind it — so the peak becomes a permanent floor for the life of the process.
- `ops/restart-server.ps1` should set `PYTORCH_HIP_ALLOC_CONF`; measured
  `expandable_segments:True,garbage_collection_threshold:0.8` → 5,129 MB, about 10 % off.
- Shrinking source pages does nothing: a 300×425 input still peaked at 5,719 MB, because
  `preprocess` upsamples to 1152² regardless.
- **bf16: tested, rejected.** `set_precision` enables bf16 on ROCm only for
  `gfx908/90a/942/950` and `gfx11xx/12xx`, so `gfx1032` runs fp32. Adding `gfx103` to that
  list does engage — the probe reports `use_bfloat16=true` and detections come back with
  bf16-rounded scores and boxes shifted about a pixel — and it buys **nothing**:

  | | peak dedicated | wall time |
  |---|---|---|
  | fp32 | 5,693 MB | 13.52 s |
  | bf16 | 5,731 MB | 13.51 s |

  Identical, and the weight-load ramp matches sample for sample. The weights halve but the
  peak does not, which points at `Tensor::scaled_dot_product_attention`: with no
  memory-efficient backend in this build it falls back to the math path, and that computes
  the attention matrix in fp32 whatever the weights are. Changing numerics for zero saving is
  strictly negative, so the change was reverted. Caveat: `empty_cache` is unavailable, so
  these are reserved-memory peaks, not live-memory peaks.

  The real lever is therefore a memory-efficient SDPA backend, not the weight dtype.

## 8. Status

Upstream 0.83.5 `cargo check --workspace` passes on this machine (609 s), with no
CUDA environment of our own: `candle`/`cudarc` are gone from the lockfile, so
`NVCC_PREPEND_FLAGS`, `CUDA_COMPUTE_CAP` and `CUDARC_CUDA_VERSION` from the
0.59.2 fork's `.cargo/config.toml` are obsolete. Only `LIBCLANG_PATH` is needed.

**Done**

- **Layer 2 shim** — `crates/koharu-control`, loopback only, three routes
  (`GET /health`, `GET /llm/current`, `PUT /llm/current`). Enabled only when
  `KOHARU_CONTROL_PORT` is set, so ordinary desktop use opens no socket.
  Hand-rolled HTTP rather than a framework: `axum` is no longer in the workspace,
  and owning ~100 lines keeps the fork's delta small across upstream refactors.
  Pinning writes through `koharu_config`, whose sections are live and
  process-wide, so the running pipeline picks the change up through its own
  subscription.
- **`ops/restart-server.ps1`** — replaces the 0.59.2 restart script. Waits for
  `/health` to report `ready` (not merely for the socket: pinning before the
  pipeline's first config read would race it), pins the model, then reads it
  back and fails loudly if it did not stick.
- **Group G** — window title, `createUpdaterArtifacts: false`, empty updater
  endpoints, rebranded icons, background-mode start (`KOHARU_TRAY_START=1`).

**Deviation from the 0.59.2 fork: no tray icon.** Tauri 3.0.0-alpha.1's
`tray-icon` feature requires `tray-icon ^0.25`, which is not published (0.24.0 is
the newest on crates.io), so commit 16's tray menu has no equivalent yet.
Instead close-to-hide is scoped to background mode only — interactive use keeps
upstream's behaviour — and the window is restored by re-launching the executable,
which `tauri_plugin_single_instance` already routes to the existing instance.
Revisit when that dependency lands.

- **Group D (prompt / LLM tuning)** — three of its four commits turned out to be
  obsolete; only one needed porting, plus one rule moved into configuration.

  | fork commit | outcome |
  |---|---|
  | 1 `enable_thinking=false` + temp 0.5 | **ported** (see below) |
  | 4 shorten prompt, strip reasoning preamble | **obsolete** — `strip_reasoning_preamble` / `find_first_block_tag` parsed the old tagged `[1] [2]` plain-text format. Upstream now requests a strict JSON schema, so there is nothing to strip; the underlying cause is fixed by commit 1 instead. |
  | 33 target-language-only output | **obsolete** — upstream's system prompt already says "Write every translated `text` value only in {target}" and "Never preserve or repeat original-language text". |
  | 34 Western digits | **ported as configuration** — upstream says nothing about numerals, and Thai has its own digits. Pinned through `translation.instructions`, which upstream appends under "Additional instructions:". |

  Commit 1 was verified, not assumed. Upstream disables thinking for remote
  OpenAI-compatible providers by sending `reasoning_effort: "none"`. Measured
  against our own server (Gemma-4-E4B on llama.cpp b9401), on identical requests:

  | request | `reasoning_content` | `content` | `finish_reason` |
  |---|---|---|---|
  | no control field | present | empty | `length` |
  | `reasoning_effort: "none"` | **present** | truncated | **`length`** |
  | `chat_template_kwargs: {"enable_thinking": false}` | absent | complete JSON | `stop` |

  llama.cpp ignores `reasoning_effort`, so the model keeps thinking, exhausts
  `max_tokens` on chain-of-thought and returns truncated JSON — which reaches
  the pipeline as blank translations. `crates/koharu-translator/src/remote/
  openai_compatible.rs` therefore also sends `chat_template_kwargs` when
  reasoning is disabled, alongside upstream's field for servers that honour it.

  Temperature and the reasoning flag are **pinned by the supervisor** rather than
  hard-coded, so they are re-asserted on every restart like the model is. There
  is a trap worth knowing: `GenerationConfig::for_model` drops the reasoning
  setting entirely when `ModelSelection.reasoning` is false, which silently lets
  a thinking model think again. `GET /llm/current` therefore reports a computed
  `thinkingSuppressed`, and `ops/restart-server.ps1` fails the restart if it is
  not true.

The shim, group G and group D are committed on `port-0.83` (`33f78c74`, `53a55ad9`,
`183d514c`). The 0.59.2 fork at `C:\Users\blakm\koharu` is intact but deliberately not
running: the owner chose 0.83.5 as the base on 2026-10-16 and accepted that the farm stays
down until group B lands.

**In progress:** group B, reduced scope — see §5.
**Not started:** groups C, A, F, E, H.

`koharu-keepalive.ps1` is deliberately **not** ported yet. Its health probe is a
one-line change (`:4000/api/v1/operations` → `:4100/health`), but its disk
cleanup walks `%LOCALAPPDATA%\Koharu\projects` and reasons about `agent-*` and
`imported-*` directories produced by the old agent. Those paths belong to
`koharu-storage` and the ported agent, so port it with group B rather than
guessing the new layout. Keep its ASCII-only rule: it is read by PowerShell 5.1
as ANSI, and a non-ASCII literal silently breaks the relaunch path.
