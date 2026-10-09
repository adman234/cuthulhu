<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Makerspace quick start: Silhouette Cameo 1 on Linux

This fork (`adman234/cuthulhu`) adds two things: Cameo 1 support (`cameo1`), and a simple window
laid out like LightBurn. The Cameo 1 support is meant to go upstream once it has been verified on
hardware. Until the hardware checklist in `apps/desktop/MANUAL-CHECKLIST.md` (§ Cameo 1) is
ticked, treat every cut as a test cut and use scrap media.

## 1. Install (Ubuntu / Debian)

```sh
sudo apt-get install -y build-essential pkg-config libudev-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
curl https://sh.rustup.rs -sSf | sh          # Rust, if not installed
cargo install tauri-cli --version '^2'       # once
git clone https://github.com/adman234/cuthulhu && cd cuthulhu
(cd apps/desktop && cargo tauri build)       # → target/release/bundle/{deb,appimage}
```

## 2. Let members use the cutter without root

```sh
sudo cp docs/linux/99-silhouette-cameo1.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

Then unplug and replug the Cameo. You do not need to blacklist the kernel printer driver
(`usblp`): Cuthulhu detaches it when it opens the cutter.

Check the setup from a terminal:

```sh
cargo run -p cli -- list-devices        # should list a cameo1 device
cargo run -p cli -- cut square.svg --device cameo1 --dry-run   # prints the bytes, cuts nothing
```

## 3. Cutting, in the simple window

1. **Machine:** in the top bar, choose **Silhouette Cameo**. The artboard becomes 295 × 3000 mm,
   which is the area the blade can reach. Artboard (0, 0) is 9 mm from the left edge of the media
   and 1 mm from the top.
2. **Design:** draw, add text, trace, or **Import** an SVG.
3. **Layers:** select shapes and click a colour in the **Layer** strip under the canvas. Each
   colour is one row in **Cuts / Layers**, and the rows are cut in the order shown.
4. **Settings per layer:**
   - **Material** sets speed and force from a preset (Vinyl Sticker, Cardstock…).
   - **Spd**, **Force** and **Passes** override the preset. Leave them blank to use it. The
     Cameo 1's speed goes up to 10.
   - **Out** off skips that layer.
5. **Cutter:** load the mat or media using the machine's own button, pick the cutter, and press
   **Connect cutter**. Then press **Start**. **Stop** cancels the cut, but the Cameo finishes the
   moves it has already received. With several layers, **Resume** continues after each one.
6. **Preview, presets and Cut Hosts…** opens the full cut dialog. Use it for the cut preview with
   travel moves, to edit presets, and to cut through a Raspberry Pi Cut Host.

**Classic layout** in the top bar switches back to the original layers and properties window.
The window remembers which layout you used last.

## Not supported yet

Track enhancing, pen (sketch) mode, print & cut with registration marks, and media size presets
are not supported yet. See `docs/superpowers/plans/2026-10-09-cameo1-and-simple-ui.md` (Part C).
