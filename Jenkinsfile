// Voicebox cross-platform desktop build.
//
// Builds the Tauri desktop app + bundled Python server sidecar on Linux,
// macOS, and Windows, and archives the platform installers. Drives the repo's
// own `just` recipes (just setup → just build) so the build stays in lockstep
// with local development.
//
//   just setup  → python venv + `pip install -r backend/requirements.txt`
//                 (incl. the git-only TTS engines, which resolve fine on real
//                 agents) + `bun install`
//   just build  → scripts/build-server.sh (PyInstaller → voicebox-server /
//                 voicebox-mcp sidecars) + `cd tauri && bun run tauri build`
//                 (bundle.targets = "all" → per-platform installers)
//
// Agents (labels): Linux `pockeo-linux`, macOS `macos`, Windows `pockeo-windows`.

pipeline {
    agent none

    options {
        timestamps()
        timeout(time: 120, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '15'))
        disableConcurrentBuilds()
    }

    environment {
        CARGO_TERM_COLOR = 'always'
        RUST_BACKTRACE = '1'
        // Non-interactive installers
        CI = 'true'
    }

    stages {
        stage('Build') {
            failFast false
            parallel {

                // ─── Linux ──────────────────────────────────────────────────
                stage('Linux') {
                    agent { label 'pockeo-linux' }
                    environment {
                        PATH = "${env.HOME}/.cargo/bin:${env.HOME}/.bun/bin:${env.HOME}/.local/bin:${env.PATH}"
                    }
                    stages {
                        stage('Linux: Toolchain') {
                            steps {
                                sh '''
                                    set -eu
                                    echo "=== rust ===" && rustc --version && cargo --version
                                    echo "=== bun ==="
                                    command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
                                    export PATH="$HOME/.bun/bin:$PATH" && bun --version
                                    echo "=== just ==="
                                    command -v just >/dev/null 2>&1 || cargo install just --locked
                                    just --version
                                    echo "=== python ==="
                                    (command -v python3.12 || command -v python3.13 || command -v python3) && python3 --version
                                '''
                            }
                        }
                        stage('Linux: Setup') {
                            steps {
                                sh 'just setup'
                            }
                        }
                        stage('Linux: Build') {
                            steps {
                                sh 'just build'
                            }
                            post {
                                success {
                                    archiveArtifacts(
                                        artifacts: 'tauri/src-tauri/target/release/bundle/**/*.deb, tauri/src-tauri/target/release/bundle/**/*.rpm, tauri/src-tauri/target/release/bundle/appimage/*.AppImage',
                                        allowEmptyArchive: true, fingerprint: true)
                                }
                            }
                        }
                    }
                }

                // ─── macOS (arm64) ──────────────────────────────────────────
                stage('macOS') {
                    agent { label 'macos' }
                    environment {
                        PATH = "/Users/jenkins/.cargo/bin:/Users/jenkins/.bun/bin:/Users/jenkins/.local/bin:/opt/homebrew/bin:/usr/local/bin:${env.PATH}"
                    }
                    stages {
                        stage('macOS: Toolchain') {
                            steps {
                                sh '''
                                    set -eu
                                    echo "=== rust ===" && rustc --version && cargo --version
                                    echo "=== bun ==="
                                    command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
                                    export PATH="$HOME/.bun/bin:$PATH" && bun --version
                                    echo "=== just ==="
                                    command -v just >/dev/null 2>&1 || cargo install just --locked
                                    just --version
                                    echo "=== cmake (some native deps need it) ==="
                                    command -v cmake >/dev/null 2>&1 || (pip3 install --user cmake 2>/dev/null || brew install cmake 2>&1 | tail -3) || true
                                    echo "=== python ==="
                                    (command -v python3.12 || command -v python3.13 || command -v python3) && python3 --version
                                '''
                            }
                        }
                        stage('macOS: Setup') {
                            steps {
                                sh 'just setup'
                            }
                        }
                        stage('macOS: Build') {
                            steps {
                                sh 'just build'
                            }
                            post {
                                success {
                                    archiveArtifacts(
                                        artifacts: 'tauri/src-tauri/target/release/bundle/**/*.dmg, tauri/src-tauri/target/release/bundle/macos/*.app.tar.gz',
                                        allowEmptyArchive: true, fingerprint: true)
                                }
                            }
                        }
                    }
                }

                // ─── Windows ────────────────────────────────────────────────
                stage('Windows') {
                    agent { label 'pockeo-windows' }
                    stages {
                        stage('Windows: Toolchain') {
                            steps {
                                powershell '''
                                    $ErrorActionPreference = "Stop"
                                    Write-Host "=== rust ==="; rustc --version; cargo --version
                                    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
                                        Write-Host "Installing bun..."; irm bun.sh/install.ps1 | iex
                                        $env:Path = "$env:USERPROFILE\\.bun\\bin;$env:Path"
                                    }
                                    bun --version
                                    if (-not (Get-Command just -ErrorAction SilentlyContinue)) {
                                        Write-Host "Installing just..."; cargo install just --locked
                                    }
                                    just --version
                                    Write-Host "=== python ==="; (Get-Command python).Source; python --version
                                '''
                            }
                        }
                        stage('Windows: Setup') {
                            steps {
                                powershell '''
                                    $ErrorActionPreference = "Stop"
                                    $env:Path = "$env:USERPROFILE\\.bun\\bin;$env:USERPROFILE\\.cargo\\bin;$env:Path"
                                    just setup
                                '''
                            }
                        }
                        stage('Windows: Build') {
                            steps {
                                powershell '''
                                    $ErrorActionPreference = "Stop"
                                    $env:Path = "$env:USERPROFILE\\.bun\\bin;$env:USERPROFILE\\.cargo\\bin;$env:Path"
                                    just build
                                '''
                            }
                            post {
                                success {
                                    archiveArtifacts(
                                        artifacts: 'tauri/src-tauri/target/release/bundle/**/*.msi, tauri/src-tauri/target/release/bundle/**/*.exe',
                                        allowEmptyArchive: true, fingerprint: true)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    post {
        success { echo 'Voicebox desktop bundles built on Linux, macOS, and Windows.' }
        failure { echo 'Build failed — see the per-platform stage logs above.' }
    }
}
