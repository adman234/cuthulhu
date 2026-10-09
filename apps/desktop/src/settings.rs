// SPDX-License-Identifier: GPL-3.0-or-later
//! The desktop's own settings file, `<config_dir>/cuthulhu/settings.json`, and the one setting it
//! holds today: where the operator's material presets live.
//!
//! A makerspace points every computer at one presets file on a network share, so a material tuned
//! at one cutter is offered at all of them. The default stays the per-user file it always was.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::device::IpcError;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    /// A presets file other than the default — typically on a share. `None` is the default file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presets_path: Option<PathBuf>,
}

/// Where presets are read and written, as the UI shows it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetsLocation {
    pub path: String,
    /// Whether `path` was chosen rather than the default.
    pub custom: bool,
    pub default_path: String,
}

pub fn default_settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("cuthulhu").join("settings.json"))
}

fn no_config_dir() -> IpcError {
    IpcError::new("no_config_dir", "this system has no configuration directory")
}

/// Absent is the first run, not a fault. A file that does not parse is refused by name rather than
/// treated as absent: silently falling back to the default would have this computer cut with its
/// own presets while the operator believes it reads the shared ones.
pub fn load(path: &Path) -> Result<AppSettings, IpcError> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(AppSettings::default()),
        Err(e) => {
            return Err(IpcError::new(
                "settings_unreadable",
                format!("the settings file {} could not be read ({e})", path.display()),
            ))
        }
    };
    serde_json::from_str(&text).map_err(|e| {
        IpcError::new(
            "settings_corrupt",
            format!("the settings file {} could not be understood ({e}); fix or delete it", path.display()),
        )
    })
}

/// Written through a temp file and a rename, like the presets file, so a crash never leaves half a
/// settings file that the next start refuses.
pub fn save(path: &Path, settings: &AppSettings) -> Result<(), IpcError> {
    let unwritable =
        |e: &dyn std::fmt::Display| IpcError::new("settings_unwritable", format!("the settings file could not be written ({e})"));
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(|e| unwritable(&e))?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| unwritable(&e))?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| unwritable(&e))?;
    tmp.as_file_mut().write_all(json.as_bytes()).map_err(|e| unwritable(&e))?;
    tmp.persist(path).map_err(|e| unwritable(&e.error))?;
    Ok(())
}

/// A chosen presets file is usable only while the folder holding it is there. That is checked
/// rather than created: `save_user_presets` creates missing folders for the default location's
/// first run, and on an unmounted share it would quietly make a local folder at the mount point —
/// this computer would then keep its own presets while every other one reads the share.
fn reachable(path: &Path) -> Result<(), IpcError> {
    let dir = path.parent().filter(|d| !d.as_os_str().is_empty());
    match dir.map(fs::metadata) {
        Some(Ok(m)) if m.is_dir() => Ok(()),
        Some(Ok(_)) => Err(unreachable(path, "the folder it names is not a folder".into())),
        Some(Err(e)) => Err(unreachable(path, e.to_string())),
        None => Err(unreachable(path, "it names no folder".into())),
    }
}

fn unreachable(path: &Path, why: String) -> IpcError {
    IpcError::new(
        "presets_unreachable",
        format!(
            "the presets file {} cannot be reached ({why}) — if it is on a network share, check the \
             share is connected, or switch back to this computer's own presets",
            path.display()
        ),
    )
}

/// The presets file every preset command and every cut reads, given where the settings live and
/// what the default would be.
pub fn presets_path_in(settings: &Path, default: &Path) -> Result<PathBuf, IpcError> {
    match load(settings)?.presets_path {
        Some(chosen) => {
            reachable(&chosen)?;
            Ok(chosen)
        }
        None => Ok(default.to_path_buf()),
    }
}

/// `presets_path_in` against the real configuration directory.
pub fn presets_path() -> Result<PathBuf, IpcError> {
    let settings = default_settings_path().ok_or_else(no_config_dir)?;
    let default = cutplan::presets::default_presets_path().ok_or_else(no_config_dir)?;
    presets_path_in(&settings, &default)
}

pub fn location_in(settings: &Path, default: &Path) -> Result<PresetsLocation, IpcError> {
    let chosen = load(settings)?.presets_path;
    Ok(PresetsLocation {
        path: chosen.as_deref().unwrap_or(default).display().to_string(),
        custom: chosen.is_some(),
        default_path: default.display().to_string(),
    })
}

/// Point presets at `chosen`, or back at the default with `None`.
///
/// A folder is taken to mean `presets.json` inside it, so the picker can offer folders and a share
/// that holds no file yet can still be chosen. The file, when it exists, is read before anything is
/// saved: a location this build cannot read would leave every cut refusing its presets.
pub fn set_location_in(settings: &Path, default: &Path, chosen: Option<PathBuf>) -> Result<PresetsLocation, IpcError> {
    let chosen = match chosen {
        None => None,
        Some(p) => {
            if !p.is_absolute() {
                return Err(IpcError::new("invalid_presets_path", "choose a presets file by its full path"));
            }
            let p = if p.is_dir() { p.join("presets.json") } else { p };
            reachable(&p)?;
            cutplan::presets::load_presets(&p)?;
            // The default chosen by hand is the default, not a custom location that happens to
            // match it.
            if p == default { None } else { Some(p) }
        }
    };
    let mut current = load(settings)?;
    current.presets_path = chosen;
    save(settings, &current)?;
    location_in(settings, default)
}

pub fn location() -> Result<PresetsLocation, IpcError> {
    let settings = default_settings_path().ok_or_else(no_config_dir)?;
    let default = cutplan::presets::default_presets_path().ok_or_else(no_config_dir)?;
    location_in(&settings, &default)
}

pub fn set_location(chosen: Option<PathBuf>) -> Result<PresetsLocation, IpcError> {
    let settings = default_settings_path().ok_or_else(no_config_dir)?;
    let default = cutplan::presets::default_presets_path().ok_or_else(no_config_dir)?;
    set_location_in(&settings, &default, chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        dir: tempfile::TempDir,
        settings: PathBuf,
        default: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("cfg").join("settings.json");
        let default = dir.path().join("cfg").join("presets.json");
        Fixture { dir, settings, default }
    }

    #[test]
    fn with_no_settings_file_presets_live_at_the_default() {
        let f = fixture();
        assert_eq!(presets_path_in(&f.settings, &f.default).unwrap(), f.default);
        let loc = location_in(&f.settings, &f.default).unwrap();
        assert!(!loc.custom);
        assert_eq!(loc.path, f.default.display().to_string());
    }

    #[test]
    fn a_chosen_folder_means_the_presets_file_inside_it_and_survives_a_reload() {
        let f = fixture();
        let share = f.dir.path().join("share");
        fs::create_dir_all(&share).unwrap();
        let loc = set_location_in(&f.settings, &f.default, Some(share.clone())).unwrap();
        assert!(loc.custom);
        assert_eq!(presets_path_in(&f.settings, &f.default).unwrap(), share.join("presets.json"));

        let back = set_location_in(&f.settings, &f.default, None).unwrap();
        assert!(!back.custom);
        assert_eq!(presets_path_in(&f.settings, &f.default).unwrap(), f.default);
    }

    /// The share being unmounted after it was chosen is the ordinary failure, and it is refused by
    /// name — never answered with the default, and never by creating a folder where the share was.
    #[test]
    fn an_unreachable_share_is_refused_with_its_own_code() {
        let f = fixture();
        let share = f.dir.path().join("share");
        fs::create_dir_all(&share).unwrap();
        set_location_in(&f.settings, &f.default, Some(share.clone())).unwrap();
        fs::remove_dir_all(&share).unwrap();
        let err = presets_path_in(&f.settings, &f.default).unwrap_err();
        assert_eq!(err.code, "presets_unreachable");
        assert!(!share.exists(), "the missing share must not be recreated locally");
    }

    #[test]
    fn a_location_that_cannot_be_used_is_refused_before_it_is_saved() {
        let f = fixture();
        let missing = f.dir.path().join("nowhere").join("presets.json");
        assert_eq!(set_location_in(&f.settings, &f.default, Some(missing)).unwrap_err().code, "presets_unreachable");
        assert_eq!(
            set_location_in(&f.settings, &f.default, Some(PathBuf::from("relative.json"))).unwrap_err().code,
            "invalid_presets_path"
        );
        let corrupt = f.dir.path().join("corrupt.json");
        fs::write(&corrupt, "not json").unwrap();
        assert_eq!(set_location_in(&f.settings, &f.default, Some(corrupt)).unwrap_err().code, "presets_corrupt");
        assert!(!f.settings.exists(), "no refused location was written");
    }

    #[test]
    fn a_damaged_settings_file_is_refused_not_ignored() {
        let f = fixture();
        fs::create_dir_all(f.settings.parent().unwrap()).unwrap();
        fs::write(&f.settings, "{").unwrap();
        assert_eq!(presets_path_in(&f.settings, &f.default).unwrap_err().code, "settings_corrupt");
    }

    #[test]
    fn choosing_the_default_by_hand_is_the_default() {
        let f = fixture();
        fs::create_dir_all(f.default.parent().unwrap()).unwrap();
        assert!(!set_location_in(&f.settings, &f.default, Some(f.default.clone())).unwrap().custom);
    }
}
