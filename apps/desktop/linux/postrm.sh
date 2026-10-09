#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# The package manager has removed the udev rule by now; reloading makes udev forget it too.
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
fi
exit 0
