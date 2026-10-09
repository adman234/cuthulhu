// SPDX-License-Identifier: GPL-3.0-or-later
//! Which Silhouette a USB device is, and what that changes on the wire.
//!
//! One driver crate speaks for the family because every model speaks GPGL; what differs is the
//! USB identity, the cutting area and a handful of commands. Holding those per model here keeps a
//! Cameo 1 from ever being enumerated as a Cameo 5 — the two would accept each other's bytes
//! closely enough to cut, and wrongly enough to cut in the wrong place.

/// A Silhouette model this build can drive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Model {
    /// Cameo 5 Alpha and Alpha Plus. [src: inkscape-silhouette silhouette/Graphtec.py L132, L147-148 (GPL-2.0+)]
    Cameo5Alpha,
    /// The original Silhouette Cameo. [src: inkscape-silhouette silhouette/Graphtec.py L131, L138 (GPL-2.0+)]
    Cameo1,
}

impl Model {
    pub const ALL: [Model; 2] = [Model::Cameo5Alpha, Model::Cameo1];

    /// The USB vendor id. The Cameo 5 Alpha moved off Graphtec's `0x0b4d`, which every earlier
    /// Silhouette — the Cameo 1 included — still enumerates under.
    pub fn vendor_id(self) -> u16 {
        match self {
            Model::Cameo5Alpha => 0x3844,
            Model::Cameo1 => 0x0b4d,
        }
    }

    pub fn product_ids(self) -> &'static [u16] {
        match self {
            // ponytail: Cameo 5 Alpha and Alpha Plus
            Model::Cameo5Alpha => &[0x0001, 0x0002],
            Model::Cameo1 => &[0x1121],
        }
    }

    pub fn matches(self, vendor_id: u16, product_id: u16) -> bool {
        vendor_id == self.vendor_id() && self.product_ids().contains(&product_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bug this guards: a device answering to two models would be offered under both
    /// machine ids, and whichever the operator picked would get its dialect.
    #[test]
    fn no_usb_identity_belongs_to_two_models() {
        for a in Model::ALL {
            for b in Model::ALL {
                if a == b { continue; }
                for &pid in a.product_ids() {
                    assert!(!b.matches(a.vendor_id(), pid), "{a:?} and {b:?} share {:04x}:{pid:04x}", a.vendor_id());
                }
            }
        }
    }

    #[test]
    fn the_cameo_1_is_graphtec_0b4d_1121() {
        assert!(Model::Cameo1.matches(0x0b4d, 0x1121));
        // The Cameo 2 (0x112b) shares the dialect but not the margins, and nobody has verified
        // it here, so it is not claimed by the Cameo 1's row.
        assert!(!Model::Cameo1.matches(0x0b4d, 0x112b));
        assert!(!Model::Cameo1.matches(0x3844, 0x1121));
    }
}
