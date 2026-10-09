# cuthulhu

Free, open-source (GPLv3), cross-platform desktop cutting software for vinyl
cutters and craft plotters — a modern, no-lock-in alternative to the
proprietary software that ships with these machines.

> **Status:** a working desktop app (Tauri + React over a Rust engine) and a CLI that shares
> its planning path. Design, trace, plan and cut on the machines below. Hardware-verified
> behaviour is tracked in `apps/desktop/MANUAL-CHECKLIST.md`; anything not ticked there is
> source-derived and awaiting a run on real hardware.

## Target machines

| Machine | Link | Status |
|---|---|---|
| **Silhouette Cameo 5 Alpha** (`3844:0001/0002`) | USB, GPGL | Verified on hardware (SP4 checklist) |
| **Silhouette Cameo (Cameo 1)** (`0b4d:1121`) | USB, GPGL | Source-derived from `inkscape-silhouette`; awaiting hardware verification — `docs/protocol/silhouette-cameo1.md` |
| **GCC Puma IV** | HPGL over serial/USB | Supported |

Other non-Cricut HPGL/DMPL cutters are on the roadmap (`docs/roadmap/supported-machines.md`).
Cricut is out of scope (closed platform).

## What it does

- **Design:** rectangles, ellipses, text in any installed font, SVG import, boolean operations,
  align and distribute, snapping, and bitmap tracing.
- **Cut planning:** group passes by colour, stroke, fill or material preset; per-pass material
  presets (speed, force, passes, track enhancing, pen/blade); preflight refuses anything the
  machine or the loaded media cannot cut — off the bed, past the machine's own speed ceiling,
  meant for another machine.
- **Two layouts:** a *simple* LightBurn-style window (colour palette under the canvas; docked
  Cuts / Layers and Cutter panels with Start / Stop, test cut, media size, mirror for HTV, cut
  preview, time estimate and a beginner mode), and the *classic* layers/properties window with
  the full cut dialog. Switch with the button at the right of the top bar.
- **Projects** save the design and the cut job — each layer's settings, the cut order, mirror and
  media — in one file.
- **Cut Hosts:** cut through a Raspberry Pi next to the machine (`docs/cut-host.md`).

## Getting started

```sh
cargo test --workspace --locked                 # engine and desktop tests
cargo run -p cli -- list-devices                # attached cutters
cargo run -p cli -- cut design.svg --device cameo1 --dry-run   # the bytes, without cutting
(cd apps/desktop && cargo tauri dev)            # the desktop app
```

Linux makerspace setup — udev rule, packaging, a walk-through of the simple window — is in
`docs/linux/makerspace-quickstart.md`. Contributor commands and the CI gates are in `CLAUDE.md`.

## Layout

- `crates/` — the engine: `geometry`, `document`, `cutplan` (passes, preflight, presets),
  `driver-core` (traits and the device manager), `driver-silhouette`, `driver-hpgl`,
  `driver-registry`, `fileio`, `trace`, `cut-host`, and the `cli`.
- `apps/desktop/` — the Tauri app; its React UI is in `apps/desktop/ui/`.
- `docs/protocol/` — machine protocol notes, with cited sources (ported GPL driver code + public docs).
- `docs/superpowers/` — design specs and implementation plans.
- `tools/` — the frozen Python protocol spike (USB decoder, square senders); research tooling,
  not the product.

## License

GPL-3.0-or-later — see `LICENSE`. Reuses the GPL drivers `inkscape-silhouette`
and `robocut`; attribution and source citations live in `docs/protocol/`.
