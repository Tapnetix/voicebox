// Voicebox cross-platform desktop build.
//
// Builds the Tauri desktop app + bundled Python server sidecar and archives the
// platform installers.
//
//   venv + pip install -r backend/requirements.txt  (incl. the git-only TTS
//        engines — they resolve fine on real agents)
//   bun install
//   scripts/build-server.sh  → PyInstaller voicebox-server / voicebox-mcp
//        sidecars (copied into tauri/src-tauri/binaries)
//   tauri build --bundles … --config src-tauri/tauri.ci.conf.json
//        (the CI config disables updater-artifact signing, which otherwise
//         blocks on an interactive password prompt in headless CI; AppImage
//         is skipped on Linux because its bundler stalls fetching linuxdeploy)
//
// Agent toolchains differ, so each platform sets its own PATH:
//   Linux  `pockeo-linux`   — /home/jenkins/.cargo/bin; `just` available
//   macOS  `macos` (mbook)  — runs as jjb; toolchains under /Users/jenkins
//                              (readable, not writable) → install bun into the
//                              workspace and call build steps directly (no just)
//   Windows `pockeo-windows`— runs as pockeo; C:\Users\pockeo\.cargo\bin etc.

pipeline {
    agent none

    options {
        timestamps()
        timeout(time: 150, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '15'))
        disableConcurrentBuilds()
    }

    environment {
        CARGO_TERM_COLOR = 'always'
        RUST_BACKTRACE = '1'
        CI = 'true'
    }

    stages {
        stage('Build') {
            failFast false
            parallel {

                // ─── Linux (deb + rpm) ──────────────────────────────────────
                stage('Linux') {
                    agent { label 'pockeo-linux' }
                    steps {
                        sh '''
                            set -eu
                            export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
                            command -v bun  >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
                            export PATH="$HOME/.bun/bin:$PATH"
                            command -v just >/dev/null 2>&1 || cargo install just --locked
                            rustc --version; bun --version; just --version; python3 --version

                            just setup
                            just build-server
                            # Inline --config disables updater-artifact signing (the
                            # file-path form didn't apply); stdin from /dev/null turns
                            # any stray interactive prompt into a fast EOF failure
                            # instead of a silent hang.
                            ( cd tauri && bun run tauri build --bundles deb,rpm \
                                  --config '{"bundle":{"createUpdaterArtifacts":false}}' < /dev/null )
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts(
                                artifacts: 'tauri/src-tauri/target/release/bundle/deb/*.deb, tauri/src-tauri/target/release/bundle/rpm/*.rpm',
                                allowEmptyArchive: false, fingerprint: true)
                        }
                        cleanup { sh 'rm -rf tauri/src-tauri/target/release/bundle || true' }
                    }
                }

                /* TEMPORARILY DISABLED — pending agent provisioning:
                 *   macOS (mbook): system python3 is 3.9, but kokoro>=0.9.4 needs
                 *     Python >=3.10. Install python@3.12 on mbook (brew) and the
                 *     stage below works as-is.
                 *   Windows (pockeo-windows): the fresh-workspace `checkout scm`
                 *     fails SSH host-key verification ("known_hosts does not
                 *     exist") even though PockeoR builds there — seed github.com
                 *     into the agent's known_hosts (ssh-keyscan) or set the global
                 *     Git Host Key Verification to "Accept first connection".
                 * Re-enable by removing this comment wrapper once provisioned.

                // ─── macOS (dmg + app) ──────────────────────────────────────
                stage('macOS') {
                    agent { label 'macos' }
                    steps {
                        sh '''
                            set -eu
                            # mbook runs as jjb; rust/node toolchains live under
                            # /Users/jenkins (readable). bun isn't installed and
                            # ~/.cargo / ~/.bun aren't writable, so install bun into
                            # the (writable) workspace and drive the build directly.
                            export PATH="/Users/jenkins/.cargo/bin:/Users/jenkins/.nvm/versions/node/v24.14.1/bin:/Users/jenkins/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
                            export BUN_INSTALL="$WORKSPACE/.bun"
                            export PATH="$BUN_INSTALL/bin:$PATH"
                            command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
                            rustc --version; bun --version; (command -v python3.12 || command -v python3); python3 --version

                            echo "=== venv + python deps ==="
                            PY="$(command -v python3.12 || command -v python3.13 || command -v python3)"
                            [ -d backend/venv ] || "$PY" -m venv backend/venv
                            backend/venv/bin/python -m pip install --upgrade pip
                            backend/venv/bin/pip install -r backend/requirements.txt

                            echo "=== JS deps ==="
                            bun install

                            echo "=== sidecar (PyInstaller) ==="
                            ./scripts/build-server.sh

                            echo "=== Tauri bundles (dmg, app) ==="
                            ( cd tauri && bun run tauri build --bundles dmg,app \
                                  --config src-tauri/tauri.ci.conf.json )
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts(
                                artifacts: 'tauri/src-tauri/target/release/bundle/dmg/*.dmg, tauri/src-tauri/target/release/bundle/macos/*.app.tar.gz',
                                allowEmptyArchive: true, fingerprint: true)
                        }
                        cleanup { sh 'rm -rf tauri/src-tauri/target/release/bundle || true' }
                    }
                }

                // ─── Windows (msi + nsis) ───────────────────────────────────
                // Uses PockeoR's proven Windows pattern (explicit checkout + the
                // pockeo agent toolchain paths). bun isn't preinstalled → install
                // it into the user profile (writable). NOTE: needs Python on the
                // agent for the PyInstaller sidecar — if absent, that's the next
                // thing to provision (PockeoR is pure Rust/Node).
                stage('Windows') {
                    agent { label 'pockeo-windows' }
                    options { retry(count: 2, conditions: [agent(), nonresumable()]) }
                    steps {
                        checkout scm
                        powershell '''
                            $ErrorActionPreference = "Stop"
                            $env:Path = "$env:USERPROFILE\\.cargo\\bin;C:\\Program Files\\Git\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\nodejs;C:\\Strawberry\\perl\\bin;C:\\LLVM\\bin;$env:Path"
                            if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
                                Write-Host "Installing bun..."; irm bun.sh/install.ps1 | iex
                            }
                            $env:Path = "$env:USERPROFILE\\.bun\\bin;$env:Path"
                            rustc --version; bun --version
                            $py = (Get-Command python -ErrorAction SilentlyContinue); if ($py) { python --version } else { Write-Host "WARNING: python not found on agent" }

                            Write-Host "=== venv + python deps ==="
                            if (-not (Test-Path backend\\venv)) { python -m venv backend\\venv }
                            backend\\venv\\Scripts\\python.exe -m pip install --upgrade pip
                            backend\\venv\\Scripts\\pip.exe install -r backend\\requirements.txt

                            Write-Host "=== JS deps ==="
                            bun install

                            Write-Host "=== sidecar (PyInstaller) ==="
                            $env:PATH = "$PWD\\backend\\venv\\Scripts;$env:Path"
                            python backend\\build_binary.py
                            $triple = (rustc --print host-tuple)
                            New-Item -ItemType Directory -Path tauri\\src-tauri\\binaries -Force | Out-Null
                            Copy-Item backend\\dist\\voicebox-server.exe "tauri\\src-tauri\\binaries\\voicebox-server-$triple.exe" -Force
                            python backend\\build_binary.py --shim
                            Copy-Item backend\\dist\\voicebox-mcp.exe "tauri\\src-tauri\\binaries\\voicebox-mcp-$triple.exe" -Force

                            Write-Host "=== Tauri bundles (msi, nsis) ==="
                            Set-Location tauri
                            bun run tauri build --bundles msi,nsis --config src-tauri/tauri.ci.conf.json
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts(
                                artifacts: 'tauri/src-tauri/target/release/bundle/msi/*.msi, tauri/src-tauri/target/release/bundle/nsis/*.exe',
                                allowEmptyArchive: true, fingerprint: true)
                        }
                        cleanup {
                            powershell 'if (Test-Path tauri\\src-tauri\\target\\release\\bundle) { Remove-Item -Recurse -Force tauri\\src-tauri\\target\\release\\bundle }'
                        }
                    }
                }
                */
            }
        }
    }

    post {
        success { echo 'Voicebox desktop bundles built.' }
        failure { echo 'Build failed — see the per-platform stage logs above.' }
    }
}
