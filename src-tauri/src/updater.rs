//! Self-update from GitHub Releases.
//!
//! Each release carries a `latest.json` (Tauri's updater format) with the version, notes and, per
//! platform, the installer URL plus a minisign signature. Reson downloads the installer, checks
//! the signature against the public key below (the private key never leaves the maintainer's
//! machine), and runs the NSIS installer in passive mode, which replaces and restarts the app.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const ENDPOINT: &str = "https://github.com/osfv/Reson/releases/latest/download/latest.json";
/// Base64 of the minisign public key (`tauri signer generate`).
const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDc4RDcyRTY4QzcyRTFCNjIKUldSaUd5N0hhQzdYZUZhaUQxRW9YYzhWNGp2UFUxNG05SW93dFRMZVV0YTVQUGFBSmZTUXVudTAK";
const PLATFORM: &str = "windows-x86_64";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: String,
    pub date: Option<String>,
    #[serde(skip)]
    url: String,
    #[serde(skip)]
    signature: String,
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    pub_date: Option<String>,
    platforms: std::collections::HashMap<String, PlatformEntry>,
}

#[derive(Deserialize)]
struct PlatformEntry {
    signature: String,
    url: String,
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .user_agent(concat!("Reson/", env!("CARGO_PKG_VERSION"), " (updater)"))
        .build()
        .into()
}

/// "v0.10.2" -> (0, 10, 2); missing parts count as 0.
fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split(['.', '-', '+']).map(|p| p.parse().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    parse_version(candidate) > parse_version(current)
}

/// Returns the update if the latest release is newer than this build.
pub fn check(current: &str) -> Result<Option<UpdateInfo>, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(20)))
        .http_status_as_error(false)
        .user_agent(concat!("Reson/", env!("CARGO_PKG_VERSION"), " (updater)"))
        .build()
        .into();
    let mut res = agent.get(ENDPOINT).call().map_err(|e| format!("Couldn't check for updates: {e}"))?;
    // Releases from before the updater existed have no manifest: nothing to offer.
    if res.status().as_u16() == 404 {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("Couldn't check for updates: GitHub returned HTTP {}", res.status().as_u16()));
    }
    let manifest: Manifest = res.body_mut().read_json().map_err(|e| format!("The update info is malformed: {e}"))?;
    if !is_newer(&manifest.version, current) {
        return Ok(None);
    }
    let entry = manifest
        .platforms
        .get(PLATFORM)
        .or_else(|| manifest.platforms.get("windows-x86_64-nsis"))
        .ok_or("This release has no Windows installer")?;
    Ok(Some(UpdateInfo {
        version: manifest.version.trim_start_matches('v').to_string(),
        current: current.to_string(),
        notes: manifest.notes,
        date: manifest.pub_date,
        url: entry.url.clone(),
        signature: entry.signature.clone(),
    }))
}

fn verify(data: &[u8], signature_b64: &str) -> Result<(), String> {
    let decode = |b64: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|e| e.to_string())
    };
    let pk = minisign_verify::PublicKey::decode(&decode(PUBLIC_KEY)?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&decode(signature_b64)?).map_err(|e| e.to_string())?;
    pk.verify(data, &sig, true).map_err(|_| "The download's signature doesn't match. Not installing it.".to_string())
}

/// Downloads, verifies and launches the installer, then quits so it can replace the app.
/// Progress arrives as `update:progress` events.
pub fn install(app: &AppHandle, update: &UpdateInfo) -> Result<(), String> {
    let mut res = agent(600).get(&update.url).call().map_err(|e| format!("Download failed: {e}"))?;
    let total = res.body().content_length();
    let mut reader = res.body_mut().as_reader();
    let mut data = Vec::with_capacity(total.unwrap_or(8 << 20) as usize);
    let mut buf = [0u8; 64 * 1024];
    let mut last_emit = 0u64;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.len() as u64 - last_emit > 256 * 1024 {
            last_emit = data.len() as u64;
            let _ = app.emit("update:progress", DownloadProgress { downloaded: last_emit, total });
        }
    }
    verify(&data, &update.signature)?;

    let dir: PathBuf = std::env::temp_dir().join("Reson-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("Reson_{}_x64-setup.exe", update.version));
    std::fs::File::create(&path).and_then(|mut f| f.write_all(&data)).map_err(|e| e.to_string())?;

    // Same switches Tauri's updater uses: passive UI, update mode, relaunch when done.
    std::process::Command::new(&path)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("Couldn't start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("v0.10.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
    }

    #[test]
    fn rejects_bad_signatures() {
        // A signature box that doesn't decode must never pass.
        assert!(verify(b"installer", "bm90IGEgc2lnbmF0dXJl").is_err());
    }

    /// The fixture was signed with the release key (`tauri signer sign`), so this proves the
    /// public key compiled into Reson matches it, and that tampering is caught.
    #[test]
    fn accepts_release_signatures_only() {
        let data = include_bytes!("../tests/fixtures/updater-fixture.txt");
        let sig = include_str!("../tests/fixtures/updater-fixture.txt.sig");
        assert!(verify(data, sig).is_ok());
        let mut tampered = data.to_vec();
        tampered[0] ^= 1;
        assert!(verify(&tampered, sig).is_err());
    }
}
