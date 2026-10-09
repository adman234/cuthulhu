<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Silhouette Cameo 1 support and a simple, LightBurn-style shell — Plan

> Fork plan (`adman234/cuthulhu`). Part A is written to go upstream as its own PR once it is
> verified on hardware. Part B stays in the fork.

**Goal:** a makerspace can drive an original Silhouette Cameo (Cameo 1, `0b4d:1121`) from Linux
through Cuthulhu, from one simple window laid out the way LightBurn users already know.

**Why Cuthulhu:** Silhouette dropped Cameo 1 USB support on Windows 10 1809+, and no free
Linux app gives that machine a full UI. Cuthulhu already has the editor, trace, presets,
pass planning and a GPGL driver; the Cameo 1 is a dialect of that driver, not a new protocol
(`docs/roadmap/supported-machines.md`, Tier 1).

## What the Cameo 1 and its software do — the feature inventory

| Feature | Where it lives | Status |
|---|---|---|
| Detect over USB, survive the `usblp` kernel driver | `driver-silhouette::usb` | **A1** |
| Init (`ESC EOT`), status poll (`ESC ENQ`) | `driver-silhouette::encode` | **A2** |
| Speed 1–10 (`!n`), force 1–33 (`FXn`), no tool suffix | `encode` | **A2** |
| Blade offset (`FC18` = 0.9 mm blade) | `encode` | **A2** |
| Media boundary (`\0,0` / `Zh,w`), portrait (`FN0`,`TB50,0`), no corner lift (`FE0,0`, `FF0,0,0`) | `encode` | **A2** |
| Hardware margins (9 mm left, 1 mm top) | `encode` + profile | **A2** |
| Feed out below the cut at the end (`M<y>,0`, `SO0`) | `encode` | **A2** |
| Multi-pass (repeat count) | already in `Settings` | **A2** |
| Material presets (the Silhouette media table) | `cutplan::presets` | **A3** |
| udev rule so a normal user can open it | `docs/linux/` | **A4** |
| Track enhancing (`FY0`) | needs a `Settings` field | later (C1) |
| Pen / sketch mode (`FC0`) | needs a tool field | later (C1) |
| Registration marks — print & cut (`TB99`,`TB52,2`,`TB51,400`,`TB53,10`,`TB55,1`,`TB123`) | print & cut sub-project | later (C2) |
| Cutting mat vs roll, media width | profile + artboard | profile only; later (C3) |
| Firmware update, SD-card cutting | Silhouette Studio only | out of scope |
| Design: shapes, text, boolean ops, align, trace, import SVG | existing editor | done |
| Colour layers with per-layer settings, output toggle | existing planner (`Grouping::Color`) | **B2** surfaces it |
| Copies, weed lines/boxes, offset/contour | not yet | later (C4) |

Every protocol fact above cites `inkscape-silhouette` `silhouette/Graphtec.py` in
`docs/protocol/silhouette-cameo1.md`.

## LightBurn as the design reference

LightBurn's main window, and what each part becomes here:

| LightBurn | Cuthulhu simple shell |
|---|---|
| Top toolbar (file, undo, import, alignment) | existing `TopBar` |
| Left tool rail (select, shapes, text, edit) | existing `ToolRail` |
| Workspace with grid and rulers | existing canvas and artboard |
| **Colour palette** along the bottom: click a swatch to put the selection on that layer | **B1** `ColorPalette` + `set_stroke_color` command |
| **Cuts / Layers** window: one row per colour, with mode, speed, power, passes, output toggle | **B2** `CutsPanel` — one row per colour pass: swatch, material preset, speed, force, passes, output |
| **Laser** window: device, Start / Pause / Stop, status | **B3** `CutterPanel` — device picker, connect, status, Start / Stop / Resume / Pass done, progress |
| Objects / Shape properties | existing `LayersPanel` + `PropertiesPanel`, behind an "Objects" tab |
| Settings, device setup, preview | existing `CutDialog` (preview, preset editor, Cut Hosts), one click away |

The simple shell is the default in the fork. A "Classic" toggle in the top bar brings back
the original layout.

## Part A — Cameo 1 driver (upstream PR)

- **A1 — identity and transport.** A `Model` enum in `driver-silhouette` (Cameo 5 Alpha,
  Cameo 1) holds the VID/PIDs. `list_locators(model)` and `UsbTransport::open_at(model, locator)`
  take it, so a Cameo 1 is never offered to the Cameo 5 row. On Linux the Cameo 1 enumerates
  as a USB printer, so `usblp` holds interface 0; open uses `detach_and_claim_interface` there.
- **A2 — dialect.** `SilhouetteDriver::cameo1()` encodes the Cameo 1 sequence. Speed is clamped
  to 1–10 in the driver (`// ponytail:` — the shared `SETTINGS_RANGES` is 1–30. A per-machine range
  over `MachineCaps` is the upgrade path). Golden-byte tests pin the stream.
- **A3 — machine row, profile, presets.** `cameo1` in `driver-registry::MACHINES`,
  `document::builtin_profiles`, and builtin presets from the inkscape-silhouette media table.
- **A4 — docs.** `docs/protocol/silhouette-cameo1.md`, a udev rule, and `MANUAL-CHECKLIST.md`
  entries. They stay unchecked until a real Cameo 1 has cut them.

**Done when:** `cargo test --workspace --locked` is green. `cuthulhu cut --machine cameo1
--dry-run` prints the documented stream. The hardware checklist then passes on a real
Cameo 1, and only after that does the upstream PR open.

## Part B — Simple shell (fork only)

- **B1 — colour palette.** Add a `document::commands::set_stroke_color(doc, ids, rgba)` command,
  shaped like `set_cut_line_type`: it descends into containers, unchanged shapes emit no op, and the
  whole change is one undo. Wire it through `state.rs` → `ipc.rs` → `generate_handler!` →
  `ipc-inventory.json` → `ipc.ts`. A 12-swatch strip under the canvas then applies a colour to the selection.
- **B2 — Cuts panel.** Re-plan with `Grouping::Color` whenever the document revision changes.
  Keep per-row overrides keyed by `PassKey` across replans. Reuse `cut/viewmodel.ts`
  (`passRowLabel`, `presetPicker`, `effectiveSettings`, `toCutRequest`). The panel holds no new
  logic of its own, only state.
- **B3 — Cutter panel.** `listDevices`, `connectDevice`, `deviceBadge`, and buttons that come only
  from `CutStatus.actions`, never from re-derived phases (CLAUDE.md). It also shows the Start request, progress from `sent`, and
  "Open full cut dialog".
- **B4 — layout switch.** `simpleLayout.ts` holds a pure, unit-tested choice of layout,
  remembered in `localStorage` and wrapped in try/catch. The "Classic" toggle lives in `TopBar`.

**Done when:** vitest, `tsc`, and the e2e smoke tests are green. `dist/` is rebuilt and committed.

## Status (2026-10-09)

- Part A is on branch `cameo1-support` and merged into the fork's `main`. `cargo test --workspace` is green, apart from
  `usb::tests::open_at_unknown_locator_reports_not_found`, which fails in any environment with no USB
  bus, identically on upstream `main`. The `cuthulhu cut --device cameo1 --dry-run` stream
  matches the golden test. Hardware verification is pending.
- Part B is on the fork's `main`. It is covered by vitest and by the e2e tests at the end of `e2e/smoke.spec.ts`, which pin
  every earlier test to the classic layout. The real-window checklist is pending.

## Part C — later

- **C1** Track enhancing and pen mode. These add `Settings` fields that pass through presets, IPC
  and the cut-host protocol, so they get a spec of their own.
- **C2** Print & cut with Cameo 1 registration marks. This needs a printable mark template and the `TB123` search.
- **C3** Media size: a 12×12 mat versus roll, and the artboard follows it.
- **C4** Copies, weed boxes and lines, and offset.
- **C5** Upstream PR for Part A, after the hardware checklist passes.
