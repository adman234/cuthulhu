#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs after the .deb or .rpm installs /etc/udev/rules.d/99-silhouette-cameo1.rules, so a Cameo
# already plugged in is opened by the logged-in user without root and without a replug.
# Never fails the install: a container or chroot has no running udev, and the rule still applies
# at the next boot or replug.
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
  udevadm trigger --subsystem-match=usb --attr-match=idVendor=0b4d >/dev/null 2>&1 || true
fi
exit 0
