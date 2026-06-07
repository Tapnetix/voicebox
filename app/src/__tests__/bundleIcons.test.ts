// @ts-nocheck — node-environment integration test (spawns the checker CLI, reads
// files). The app tsconfig restricts ambient types to vite/client (browser), so
// node built-ins aren't typed here; vitest runs this under Node regardless.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// app/src/__tests__ -> repo root is three levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-bundle-icons.mjs');
const REAL_SRC_TAURI = join(REPO_ROOT, 'tauri', 'src-tauri');

/** Run the checker CLI; return { code, output }. */
function run(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const tmpDirs: string[] = [];
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'voiceit-icons-'));
  tmpDirs.push(d);
  mkdirSync(join(d, 'icons'));
  // Start from the real, valid icns so only the deliberately-broken aspect fails.
  copyFileSync(join(REAL_SRC_TAURI, 'icons', 'icon.icns'), join(d, 'icons', 'icon.icns'));
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('desktop bundle icon configuration', () => {
  it('the real tauri.conf.json + icon.icns + Info.plist pass validation', () => {
    const { code, output } = run(REAL_SRC_TAURI);
    expect(output, output).toMatch(/bundle icon check: PASS/);
    expect(code).toBe(0);
  });

  it('fails when Info.plist points CFBundleIconFile at an unbundled name (regression: voiceit)', () => {
    const d = fixture();
    writeFileSync(
      join(d, 'tauri.conf.json'),
      JSON.stringify({ bundle: { icon: ['icons/icon.icns'], macOS: { infoPlist: 'Info.plist' } } }),
    );
    writeFileSync(
      join(d, 'Info.plist'),
      '<plist><dict><key>CFBundleIconFile</key><string>voiceit</string></dict></plist>',
    );
    const { code, output } = run(d);
    expect(code).toBe(1);
    expect(output).toMatch(/CFBundleIconFile="voiceit"/);
  });

  it('fails when an icns retina chunk size does not match its type code', () => {
    const d = fixture();
    // Relabel the ic10 (1024) chunk as ic14 (must be 512) -> dimension mismatch.
    const out = Buffer.from(readFileSync(join(d, 'icons', 'icon.icns')));
    for (let off = 8; off + 8 <= out.length; ) {
      const type = out.toString('latin1', off, off + 4);
      const len = out.readUInt32BE(off + 4);
      if (type === 'ic10') {
        out.write('ic14', off, 4, 'latin1');
        break;
      }
      off += len;
    }
    writeFileSync(join(d, 'icons', 'icon.icns'), out);
    writeFileSync(join(d, 'tauri.conf.json'), JSON.stringify({ bundle: { icon: ['icons/icon.icns'] } }));
    const { code, output } = run(d);
    expect(code).toBe(1);
    expect(output).toMatch(/ic14.*512x512.*embeds 1024x1024/s);
  });

  it('fails when a referenced icon path is missing', () => {
    const d = fixture();
    writeFileSync(join(d, 'tauri.conf.json'), JSON.stringify({ bundle: { icon: ['icons/nope.icns'] } }));
    const { code, output } = run(d);
    expect(code).toBe(1);
    expect(output).toMatch(/does not exist/);
  });
});
