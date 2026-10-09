<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Silhouette Cameo (Cameo 1): command set

Ported from the GPL driver `inkscape-silhouette`, file `silhouette/Graphtec.py`
(GPL-2.0-or-later), at commit `f166edcc24ae5f8602f2e292acde0cd4dd86f154` (fetched 2026-10-09).
Cite lines as `[src: inkscape-silhouette silhouette/Graphtec.py L### (GPL-2.0+)]`.

The Cameo 1 uses the same GPGL framing as the Cameo 5 (`silhouette-cameo5.md`): ETX-terminated
ASCII commands, `ESC EOT` to initialise, `ESC ENQ` for status, 20 units/mm, and `(y, x)`
coordinates. This file records only where the Cameo 1 **differs**. inkscape-silhouette sends
the Cameo 1 down its "not Cameo 3 or later" branches.

**Status: not yet verified on hardware.** Everything here is from source. The hardware
checklist in `apps/desktop/MANUAL-CHECKLIST.md` (§ Cameo 1) is what turns it into fact.

## Device identity (USB)

| Field | Value | Source |
|---|---|---|
| Vendor ID | `0x0b4d` (Graphtec) | `[src: Graphtec.py L131 (GPL-2.0+)]` |
| Product ID | `0x1121` | `[src: Graphtec.py L138 (GPL-2.0+)]` |
| Bulk OUT / IN | `0x01` / `0x82` | `[src: Graphtec.py L753, L863 (GPL-2.0+)]` |
| Interface | `0`. On Linux, `usblp` claims it as a printer, so it must be detached first | `[src: Graphtec.py L585-597 (GPL-2.0+)]` |

On Linux, a normal user needs a udev rule to open the device; see `docs/linux/99-silhouette-cameo1.rules`.
On Windows the device binds to `usbprint`, and libusb-style access needs a WinUSB driver (for
example, via Zadig). Silhouette themselves dropped Cameo 1 USB support on Windows 10 1809 and later.

## Geometry

| Fact | Value | Source |
|---|---|---|
| Media width | 304 mm | `[src: Graphtec.py L218-221 (GPL-2.0+)]` |
| Max length (roll) | 3000 mm | same |
| Left margin the carriage cannot reach | 9 mm | same |
| Top margin kept for reverse feeds | 1 mm | same |

inkscape-silhouette shifts every point by the margins (`x_off += llx`, `y_off += ury`)
`[src: Graphtec.py L1436-1438, L1501-1502, L1612 (GPL-2.0+)]`. Cuthulhu does the same in the
driver, and its `cameo1` profile is the reachable area: **295 × 3000 mm**. A design at the
artboard's (0, 0) is cut 9 mm from the media's left edge and 1 mm from its top.

## Session

| Step | Bytes | Source |
|---|---|---|
| Init | `ESC EOT` | `[src: Graphtec.py L958-965 (GPL-2.0+)]` |
| Track enhancing off | `FY1` (`FY0` turns it on; it needs force ≥ 19) | `[src: Graphtec.py L1276-1285 (GPL-2.0+)]` |
| Portrait, reset | `FN0`, `TB50,0` | `[src: Graphtec.py L1287-1298 (GPL-2.0+)]` |
| No lift between paths | `FE0,0` | `[src: Graphtec.py L1300-1301 (GPL-2.0+)]` |
| Cutting area | `\0,0`, `Z<bottom>,<right>` | `[src: Graphtec.py L1604-1607 (GPL-2.0+)]` |
| Plot mode, no corner lift, no overcut | `L0`, `FE0,0`, `FF0,0,0` | `[src: Graphtec.py L1608-1610 (GPL-2.0+)]` |

### Per pass

| Step | Bytes | Source |
|---|---|---|
| Speed | `!<1..10>`, with no tool suffix | `[src: Graphtec.py L1203-1211 (GPL-2.0+)]` |
| Force | `FX<1..33>`, with no tool suffix | `[src: Graphtec.py L1213-1221 (GPL-2.0+)]` |
| Blade offset | `FC18` for the 0.9 mm blade, `FC0` for a pen | `[src: Graphtec.py L1241-1259 (GPL-2.0+)]` |
| Paths | `M<y>,<x>`, then `D<y>,<x>`… | `[src: Graphtec.py L1339-1345 (GPL-2.0+)]` |

There is no `J` (tool select). The Cameo 1 has one tool holder `[src: Graphtec.py L169, L1151-1152 (GPL-2.0+)]`.

### End

`M<furthest y>,0`, then `SO0`: feed the media below the cut and make that the new origin, so the next
job starts on clean media `[src: Graphtec.py L1646-1649 (GPL-2.0+)]`. Cuthulhu feeds past the
furthest pass of the session, not just the last one.

## Differences from inkscape-silhouette's ordering

inkscape-silhouette sends speed, force and blade offset **before** `FY1`/`FN0`/`TB50,0`,
because it does setup once per job. Cuthulhu sends speed, force and blade offset per pass, after the job-wide
setup, so that each colour pass can carry its own settings. That ordering is the first thing
for the hardware checklist to confirm.

## Not yet implemented

- Media type `FW<n>`. Speed and force are always sent explicitly from the preset instead
  `[src: Graphtec.py L1122-1125 (GPL-2.0+)]`.
- Track enhancing on (`FY0`) and pen mode (`FC0`). Both need new `Settings` fields.
- Registration marks: `TB50,0`, `TB99`, `TB52,2`, `TB51,400`, `TB53,10`, `TB55,1`, then
  `TB123,h,w,t,l` for an automatic search or `TB23,h,w` for a manual one. A reply of `    0` means found
  `[src: Graphtec.py L1549-1577 (GPL-2.0+)]`.
- Firmware query `FG`. The driver has no read path in its session framing.
