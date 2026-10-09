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
| Interface | `0`. On Linux, `usblp` claims it as a printer, so it must be detached first | `[src: Graphtec.py L589-596 (GPL-2.0+)]` |

On Linux, a normal user needs a udev rule to open the device; see `docs/linux/99-silhouette-cameo1.rules`.
On Windows the device binds to `usbprint`, and libusb-style access needs a WinUSB driver (for
example, via Zadig). Silhouette themselves dropped Cameo 1 USB support on Windows 10 1809 and later
`[doc: Windows 10 1809 Update Impacting Some Silhouette Machines, https://silhouetteschoolblog.com/2019/08/windows-10-1809-update-impacting-some.html]`.

## Geometry

| Fact | Value | Source |
|---|---|---|
| Media width | 304 mm | `[src: Graphtec.py L218-221 (GPL-2.0+)]` |
| Max length (roll) | 3000 mm | same |
| Left margin the carriage cannot reach | 9 mm | same |
| Top margin kept for reverse feeds | 1 mm | same |

inkscape-silhouette shifts every point by the margins (`x_off += llx`, `y_off += ury`)
`[src: Graphtec.py L1436-1438, L1501-1502, L1612 (GPL-2.0+)]`. Cuthulhu does the same in the
driver, and its `cameo1` profile is the reachable area: **295 × 2999 mm**, so the cutting area's far
corner (`Z60000,6080`) is the device's own 304 × 3000 mm. A design at the
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
| Blade offset | `FC18` for the 0.9 mm blade, `FC0` for a pen | `[src: Graphtec.py L1244-1259 (GPL-2.0+)]` |
| Paths | `M<y>,<x>`, then `D<y>,<x>`… | `[src: Graphtec.py L1339-1345 (GPL-2.0+)]` |

There is no `J` (tool select). The Cameo 1 has one tool holder `[src: Graphtec.py L169, L1151-1152 (GPL-2.0+)]`.

### End

`M<furthest y>,0`, then `SO0`: feed the media below the cut and make that the new origin, so the next
job starts on clean media `[src: Graphtec.py L1646-1649 (GPL-2.0+)]`. Cuthulhu feeds past the
furthest pass of the session, not just the last one.

## Differences from inkscape-silhouette's ordering

inkscape-silhouette sends speed, force and blade offset **before** `FY1`/`FN0`/`TB50,0`,
because it does setup once per job. Cuthulhu sends speed, force and blade offset per pass, after the job-wide
setup, so that each colour pass can carry its own settings. The Silhouette Studio captures
recorded in inkscape-silhouette use this order (the model is not named): `FN0 TB50,0 \30,0 Z… FX33 !5 FC18 FE0,0 FF0,0,0 FY1`, then the paths
`[src: inkscape-silhouette Commands.md L410-443 (GPL-2.0+)]`.

A one-point path is skipped, as inkscape-silhouette skips it `[src: Graphtec.py L1443 (GPL-2.0+)]`.
A cancelled or failed job sends no epilogue, so it does not feed or set a new origin. Move the media
on by hand before cutting again.

## Not yet implemented

- Media type `FW<n>`. Speed and force are always sent explicitly from the preset instead
  `[src: Graphtec.py L1122-1125 (GPL-2.0+)]`.
- Track enhancing on (`FY0`) and pen mode (`FC0`). Both need new `Settings` fields.
- Registration with a manual search (`TB23,h,w`), which needs the head jogged over the first mark
  `[src: Graphtec.py L1364-1366, L1564-1566 (GPL-2.0+)]`. Only the automatic search is sent.
- Firmware query `FG`. The driver has no read path in its session framing.

## Registration marks (print & cut)

Implemented from source; **not verified on hardware** (MANUAL-CHECKLIST § Print & cut).

### The printed marks

The "Cameo, Portrait" layout (`TB52,2`) that inkscape-silhouette's template draws: a filled 5 mm square
at the origin, and an L at the top-right and bottom-left corners with 20 mm arms and a 0.3 mm line
`[src: inkscape-silhouette render_silhouette_regmarks.py L67-74, L90-98, L204-213 (GPL-2.0+)]`. The
default origin is 10 mm in from the sheet's top-left, with the marks spanning the sheet less that
inset each way `[src: render_silhouette_regmarks.inx L10-11; render_silhouette_regmarks.py L169-180 (GPL-2.0+)]`.
`width` and `length` run from the square's top-left corner to the L corners (the line centres)
`[src: Commands.md L181 (GPL-2.0+)]`. Cuthulhu reads the area back off the marks' geometry, as
inkscape-silhouette reads it off an existing template `[src: sendto_silhouette.py L846-855 (GPL-2.0+)]`.

### The session

| Step | Bytes | Source |
|---|---|---|
| Init and setup | `ESC EOT`, `FN0`, `TB50,0`, `FE0,0` | as § Session |
| Mark description | `TB50,0`, `TB99`, `TB52,2` (type), `TB51,400` (arm, SU), `TB53,10` (line, SU), `TB55,1` | `[src: Graphtec.py L1549-1555 (GPL-2.0+)]`, `[src: Commands.md L178-190 (GPL-2.0+)]` |
| Automatic search | `TB123,<length>,<width>,<top>,<left>` in SU; top/left are the mark origin less 10 mm, not below 0 | `[src: Graphtec.py L1355-1357, L1557-1563 (GPL-2.0+)]` |
| Wait | read until ETX within 40 s; `    0\x03` is found, anything else fails the job | `[src: Graphtec.py L1574-1576 (GPL-2.0+)]` |
| Cutting area | `\0,0`, `Z<length>,<width>`, `L0`, `FE0,0`, `FF0,0,0` | `[src: Graphtec.py L1545-1547, L1604-1610 (GPL-2.0+)]` |
| Paths | `(x - origin_x + 9 mm, y - origin_y + 1 mm)`: the mark is the origin, the margins still apply | `[src: Graphtec.py L1535-1543, L1612-1614, L1433-1438 (GPL-2.0+)]` |

`TB51`/`TB53` are sent as the source sends them, whatever was printed: they describe what the sensor
looks for. The reply is read in 250 ms slices so a cancel lands during the scan; robocut reads two
further replies after the first (`    0`, `    1`) `[src: robocut src/Plotter.cpp L483-517 (GPL-3.0+)]`,
which inkscape-silhouette does not wait for and Cuthulhu does not either — a stray one reads as "not
ready" to the next status poll, which keeps polling.

The Cameo 5 Alpha searches four L-marks with `TB124` `[src: Graphtec.py L258-261, L1359-1362 (GPL-2.0+)]`;
its caps do not offer registration until that is checked against its dialect.
