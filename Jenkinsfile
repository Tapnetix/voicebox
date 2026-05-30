// Voicebox cross-platform desktop build.
//
// Builds the Tauri desktop app + bundled Python server sidecar and archives the
// platform installers. Drives the repo's own `just` recipes so CI stays in
// lockstep with local development:
//
//   just setup        → python venv + `pip install -r backend/requirements.txt`
//                       (incl. the git-only TTS engines — they resolve fine on
//                       real agents) + `bun install`
//   just build-server → scripts/build-server.sh (PyInstaller → voicebox-server /
//                       voicebox-mcp sidecars, copied into tauri/src-tauri/binaries)
//   tauri build --bundles … → per-platform installers
//
// Each platform runs as a single shell so PATH bootstrapping persists across
// the toolchain/setup/build steps.
//
// Agents (labels): Linux `pockeo-linux`, macOS `macos`. Windows (`pockeo-windows`)
// is wired but disabled — those agents can't yet clone over SSH (the
// github-pockeo-ssh deploy key + known_hosts aren't provisioned there); enable
// the stage once that's set up.

pipeline {
    agent none

    options {
        timestamps()
        timeout(time: 180, unit: 'MINUTES')
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

                // ─── Linux ──────────────────────────────────────────────────
                // Bundle deb + rpm only. AppImage is skipped: tauri's AppImage
                // bundler downloads linuxdeploy tooling and stalls on these
                // agents — add it back once that tooling is cached locally.
                stage('Linux') {
                    agent { label 'pockeo-linux' }
                    steps {
                        sh '''
                            set -eu
                            export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

                            echo "=== Toolchain ==="
                            rustc --version && cargo --version
                            command -v bun  >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
                            export PATH="$HOME/.bun/bin:$PATH"
                            command -v just >/dev/null 2>&1 || cargo install just --locked
                            bun --version && just --version
                            python3 --version

                            echo "=== Setup (venv + deps + bun install) ==="
                            just setup

                            echo "=== Build sidecar ==="
                            just build-server

                            echo "=== Build Tauri bundles (deb, rpm) ==="
                            ( cd tauri && bun run tauri build --bundles deb,rpm )
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts(
                                artifacts: 'tauri/src-tauri/target/release/bundle/deb/*.deb, tauri/src-tauri/target/release/bundle/rpm/*.rpm',
                                allowEmptyArchive: false, fingerprint: true)
                        }
                    }
                }

                // ─── macOS (arm64) ──────────────────────────────────────────
                stage('macOS') {
                    agent { label 'macos' }
                    steps {
                        sh '''
                            set -eu
                            export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

                            echo "=== Toolchain ==="
                            rustc --version && cargo --version
                            # Prefer an already-installed bun (homebrew/global); only install
                            # into the writable workspace if missing ($HOME/.bun may be unwritable).
                            if ! command -v bun >/dev/null 2>&1; then
                                export BUN_INSTALL="$WORKSPACE/.bun"
                                curl -fsSL https://bun.sh/install | bash
                                export PATH="$BUN_INSTALL/bin:$PATH"
                            fi
                            command -v just >/dev/null 2>&1 || cargo install just --locked
                            command -v cmake >/dev/null 2>&1 || (pip3 install --user cmake 2>/dev/null || true)
                            bun --version && just --version
                            python3 --version

                            echo "=== Setup (venv + deps + bun install) ==="
                            just setup

                            echo "=== Build sidecar ==="
                            just build-server

                            echo "=== Build Tauri bundles (dmg, app) ==="
                            ( cd tauri && bun run tauri build --bundles dmg,app )
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts(
                                artifacts: 'tauri/src-tauri/target/release/bundle/dmg/*.dmg, tauri/src-tauri/target/release/bundle/macos/*.app.tar.gz',
                                allowEmptyArchive: true, fingerprint: true)
                        }
                    }
                }

                // ─── Windows ────────────────────────────────────────────────
                // DISABLED: the pockeo-windows agents can't clone Tapnetix/voicebox
                // over SSH (deploy key / known_hosts not provisioned). Once SSH is
                // set up on those agents (or the job source is switched to HTTPS),
                // uncomment this stage — `just build` has working [windows] recipes.
                //
                // stage('Windows') {
                //     agent { label 'pockeo-windows' }
                //     steps {
                //         powershell '''
                //             $ErrorActionPreference = "Stop"
                //             $env:Path = "$env:USERPROFILE\\.cargo\\bin;$env:USERPROFILE\\.bun\\bin;$env:Path"
                //             if (-not (Get-Command bun  -ErrorAction SilentlyContinue)) { irm bun.sh/install.ps1 | iex; $env:Path = "$env:USERPROFILE\\.bun\\bin;$env:Path" }
                //             if (-not (Get-Command just -ErrorAction SilentlyContinue)) { cargo install just --locked }
                //             just setup
                //             just build-server
                //             Set-Location tauri; bun run tauri build --bundles msi,nsis
                //         '''
                //     }
                //     post { success { archiveArtifacts artifacts: 'tauri/src-tauri/target/release/bundle/**/*.msi, tauri/src-tauri/target/release/bundle/**/*.exe', allowEmptyArchive: true, fingerprint: true } }
                // }
            }
        }
    }

    post {
        success { echo 'Voicebox desktop bundles built on Linux + macOS.' }
        failure { echo 'Build failed — see the per-platform stage logs above.' }
    }
}
