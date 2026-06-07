#!/usr/bin/env node
// Validate the desktop bundle icon configuration BEFORE a build produces a
// broken installer. This guards the two real bugs that shipped to users:
//
//   1. icon.icns retina chunks (ic11..ic14) declared one size but embedded a
//      PNG of the next size up. macOS rejects an icns whose embedded image
//      dimensions don't match the type code and falls back to the generic
//      blank icon (Finder / Dock / the .app inside the dmg).
//   2. The custom Info.plist set CFBundleIconFile=voiceit, but Tauri bundles
//      the icns as icon.icns — so macOS looked for Resources/voiceit.icns,
//      which never existed, and showed the generic icon.
//
// Pure ESM, Node built-ins only — runs under `node` or `bun`. Exits non-zero
// (with diagnostics) on any problem so it can gate a CI build. Also exported as
// checkBundleIcons() so the unit suite can assert the same invariants.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

// icns type code -> the exact square pixel size its image MUST be.
// (Only PNG/JP2-bearing types are validated; legacy raw masks like is32/il32/
// s8mk and metadata chunks like 'info'/'TOC '/'icnV' are skipped.)
const ICNS_PNG_SIZES = {
  icp4: 16, icp5: 32, icp6: 64,
  ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
  ic11: 32, ic12: 64, ic13: 256, ic14: 512,
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse an .icns buffer into [{ type, size, png:{w,h}|null }]. */
function parseIcns(buf) {
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'icns') {
    throw new Error('not an icns file (bad magic)');
  }
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const type = buf.toString('latin1', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) break;
    const payload = buf.subarray(off + 8, off + len);
    let png = null;
    if (payload.length >= 24 && payload.subarray(0, 8).equals(PNG_MAGIC)) {
      // IHDR width/height live at bytes 16..24 of the PNG stream.
      png = { w: payload.readUInt32BE(16), h: payload.readUInt32BE(20) };
    }
    chunks.push({ type, size: payload.length, png });
    off += len;
  }
  return chunks;
}

/** Read a top-level <key>X</key><string>Y</string> from a (simple) plist. */
function readPlistString(text, key) {
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const m = text.match(re);
  return m ? m[1] : null;
}

/**
 * Validate the bundle icon config under a tauri src-tauri directory.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], summary: string[] }}
 */
export function checkBundleIcons(srcTauriDir) {
  const errors = [];
  const warnings = [];
  const summary = [];

  const confPath = resolve(srcTauriDir, 'tauri.conf.json');
  if (!existsSync(confPath)) {
    return { ok: false, errors: [`tauri.conf.json not found at ${confPath}`], warnings, summary };
  }
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  const iconList = conf?.bundle?.icon;
  if (!Array.isArray(iconList) || iconList.length === 0) {
    errors.push('bundle.icon is missing or empty in tauri.conf.json');
    return { ok: false, errors, warnings, summary };
  }

  // 1. Every referenced icon path must exist.
  const icnsList = [];
  for (const rel of iconList) {
    const p = resolve(srcTauriDir, rel);
    if (!existsSync(p)) {
      errors.push(`bundle.icon references "${rel}" but ${p} does not exist`);
    } else if (statSync(p).size === 0) {
      errors.push(`bundle.icon "${rel}" is an empty file`);
    } else if (rel.toLowerCase().endsWith('.icns')) {
      icnsList.push({ rel, path: p });
    }
  }
  summary.push(`bundle.icon: ${iconList.length} entries, all present`);

  // 2. Every .icns must be structurally valid (chunk dims match type codes).
  if (icnsList.length === 0) {
    errors.push('bundle.icon lists no .icns file — macOS has no app icon');
  }
  for (const { rel, path } of icnsList) {
    const errBefore = errors.length;
    let chunks;
    try {
      chunks = parseIcns(readFileSync(path));
    } catch (e) {
      errors.push(`${rel}: ${e.message}`);
      continue;
    }
    let validHiRes = false;
    for (const c of chunks) {
      const expect = ICNS_PNG_SIZES[c.type];
      if (expect && c.png) {
        if (c.png.w !== expect || c.png.h !== expect) {
          errors.push(
            `${rel}: chunk '${c.type}' must hold a ${expect}x${expect} image but embeds ${c.png.w}x${c.png.h} ` +
            `(macOS will reject this icns and show the generic blank icon)`,
          );
        }
        if (expect >= 256 && c.png.w === expect) validHiRes = true;
      }
    }
    if (!validHiRes) {
      errors.push(`${rel}: no valid >=256px PNG chunk (ic08/ic09/ic10) — icon will look blank/low-res`);
    } else if (errors.length === errBefore) {
      summary.push(`${rel}: ${chunks.length} chunks, all PNG dimensions match their type codes`);
    }
  }

  // 3. A custom Info.plist must not point CFBundleIconFile/Name at a name that
  //    isn't the bundled icns. Tauri copies the .icns to Resources/icon.icns and
  //    expects CFBundleIconFile to be "icon" or "icon.icns".
  const plistPath = conf?.bundle?.macOS?.infoPlist
    ? resolve(srcTauriDir, conf.bundle.macOS.infoPlist)
    : resolve(srcTauriDir, 'Info.plist');
  if (existsSync(plistPath)) {
    const plist = readFileSync(plistPath, 'utf8');
    const ACCEPTED = new Set(['icon', 'icon.icns']);
    const errBefore = errors.length;
    for (const key of ['CFBundleIconFile', 'CFBundleIconName']) {
      const val = readPlistString(plist, key);
      if (val == null) continue;
      if (!ACCEPTED.has(val)) {
        const msg =
          `${basename(plistPath)}: ${key}="${val}" but Tauri bundles the icns as "icon.icns" ` +
          `(no "${val}.icns" is shipped → macOS shows the generic icon). ` +
          `Remove this key (let Tauri set it) or use "icon.icns".`;
        if (key === 'CFBundleIconFile') errors.push(msg);
        else warnings.push(msg);
      }
    }
    if (errors.length === errBefore) {
      summary.push(`${basename(plistPath)}: CFBundleIconFile coherent`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, summary };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dir = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(scriptDir, '..', 'tauri', 'src-tauri');
  const { ok, errors, warnings, summary } = checkBundleIcons(dir);
  for (const s of summary) console.log(`  ✓ ${s}`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  if (ok) {
    console.log('bundle icon check: PASS');
    process.exit(0);
  }
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('bundle icon check: FAIL');
  process.exit(1);
}
