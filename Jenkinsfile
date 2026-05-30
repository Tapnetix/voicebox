// Voicebox cross-platform desktop build.
//
// Builds the Tauri desktop app + bundled Python server sidecar and archives the
// platform installers (Linux .deb, macOS .dmg, Windows NSIS .exe). The bundles
// are large (~2.7 GB — the PyInstaller sidecar bundles torch + the TTS engines),
// so we build ONE installer type per platform to keep compression time sane
// (rpm's xz on a multi-GB payload takes far too long; deb is the Linux target).
//
// Per-platform notes:
//   Linux  `pockeo-linux`   — /home/jenkins toolchains; `just` available.
//   macOS  `macos` (mbook)  — agent runs as jenkins but $HOME defaults to
//                              /Users/jjb (mismatch) → force HOME=/Users/jenkins;
//                              brew is unwritable, so Python 3.12 comes from uv.
//   Windows `pockeo-windows`— Python 3.12 via uv; bun installed into the profile.
// Python 3.12 is required (kokoro>=0.9.4 needs >=3.10) — uv provides it on
// mac/Windows without brew/sudo. A throwaway no-password tauri signing key makes
// updater-artifact signing non-interactive (the conf pins an updater pubkey).

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

                // ─── Linux (.deb) ───────────────────────────────────────────
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
                            ( cd tauri
                              bun run tauri signer generate --ci --force -w ./.tauri-ci.key
                              export TAURI_SIGNING_PRIVATE_KEY="$(cat ./.tauri-ci.key)"
                              export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
                              bun run tauri build --bundles deb < /dev/null )
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts artifacts: 'tauri/src-tauri/target/release/bundle/deb/*.deb',
                                allowEmptyArchive: false, fingerprint: true
                        }
                        cleanup { sh 'rm -rf tauri/src-tauri/target/release/bundle || true' }
                    }
                }

                // ─── macOS (.dmg) ───────────────────────────────────────────
                stage('macOS') {
                    agent { label 'macos' }
                    steps {
                        sh '''
                            set -eu
                            export HOME=/Users/jenkins
                            export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/Users/jenkins/.nvm/versions/node/v24.14.1/bin:/Users/jenkins/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
                            export BUN_INSTALL="$HOME/.bun"
                            command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
                            export PATH="$BUN_INSTALL/bin:$PATH"
                            uv --version; rustc --version; bun --version

                            echo "=== venv (python 3.12 via uv) ==="
                            rm -rf backend/venv
                            uv venv --python 3.12 --seed backend/venv
                            backend/venv/bin/python -m pip install --upgrade pip
                            backend/venv/bin/pip install -r backend/requirements.txt

                            bun install
                            ./scripts/build-server.sh
                            ( cd tauri
                              bun run tauri signer generate --ci --force -w ./.tauri-ci.key
                              export TAURI_SIGNING_PRIVATE_KEY="$(cat ./.tauri-ci.key)"
                              export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
                              bun run tauri build --bundles dmg < /dev/null )
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts artifacts: 'tauri/src-tauri/target/release/bundle/dmg/*.dmg',
                                allowEmptyArchive: true, fingerprint: true
                        }
                        cleanup { sh 'rm -rf tauri/src-tauri/target/release/bundle || true' }
                    }
                }

                // ─── Windows (NSIS .exe) ────────────────────────────────────
                stage('Windows') {
                    agent { label 'pockeo-windows' }
                    options { retry(count: 2, conditions: [agent(), nonresumable()]) }
                    steps {
                        checkout scm
                        powershell '''
                            $ErrorActionPreference = "Stop"
                            $env:Path = "$env:USERPROFILE\\.local\\bin;$env:USERPROFILE\\.cargo\\bin;$env:USERPROFILE\\.bun\\bin;C:\\Program Files\\Git\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\nodejs;C:\\Strawberry\\perl\\bin;C:\\LLVM\\bin;$env:Path"
                            if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { irm bun.sh/install.ps1 | iex; $env:Path = "$env:USERPROFILE\\.bun\\bin;$env:Path" }
                            uv --version; bun --version; rustc --version

                            Write-Host "=== venv (python 3.12 via uv) ==="
                            if (Test-Path backend\\venv) { Remove-Item -Recurse -Force backend\\venv }
                            uv venv --python 3.12 --seed backend\\venv
                            backend\\venv\\Scripts\\python.exe -m pip install --upgrade pip
                            backend\\venv\\Scripts\\pip.exe install -r backend\\requirements.txt

                            bun install
                            $env:PATH = "$PWD\\backend\\venv\\Scripts;$env:Path"
                            python backend\\build_binary.py
                            $triple = (rustc --print host-tuple)
                            New-Item -ItemType Directory -Path tauri\\src-tauri\\binaries -Force | Out-Null
                            Copy-Item backend\\dist\\voicebox-server.exe "tauri\\src-tauri\\binaries\\voicebox-server-$triple.exe" -Force
                            python backend\\build_binary.py --shim
                            Copy-Item backend\\dist\\voicebox-mcp.exe "tauri\\src-tauri\\binaries\\voicebox-mcp-$triple.exe" -Force

                            Set-Location tauri
                            bun run tauri signer generate --ci --force -w .tauri-ci.key
                            $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri-ci.key -Raw)
                            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
                            bun run tauri build --bundles nsis
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts artifacts: 'tauri/src-tauri/target/release/bundle/nsis/*.exe',
                                allowEmptyArchive: true, fingerprint: true
                        }
                        cleanup {
                            powershell 'if (Test-Path tauri\\src-tauri\\target\\release\\bundle) { Remove-Item -Recurse -Force tauri\\src-tauri\\target\\release\\bundle }'
                        }
                    }
                }
            }
        }
    }

    post {
        success { echo 'Voicebox desktop bundles built (Linux .deb, macOS .dmg, Windows NSIS).' }
        failure { echo 'Build failed — see the per-platform stage logs above.' }
    }
}
