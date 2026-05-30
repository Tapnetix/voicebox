"""CI helper: disable Tauri updater-artifact creation for release builds.

The committed tauri.conf.json pins an updater pubkey and sets
createUpdaterArtifacts, which makes `tauri build` try to sign updater archives
(blocking on an interactive key-password prompt) and error when the chosen
bundle target isn't updater-enabled (e.g. Linux .deb). CI produces plain
installers, so disable updater artifacts before building. Idempotent; edits the
config in the (disposable) build workspace only.
"""
import json
import pathlib

p = pathlib.Path("tauri/src-tauri/tauri.conf.json")
cfg = json.loads(p.read_text())
cfg.setdefault("bundle", {})["createUpdaterArtifacts"] = False
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("CI: set bundle.createUpdaterArtifacts = false")
