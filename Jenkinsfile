// Voicebox cross-platform desktop build.
//
// Builds the Tauri desktop app + bundled Python server sidecar and archives the
// platform installers (Linux .deb, macOS .dmg, Windows NSIS .exe). The bundles
// are large (~2.7 GB — the PyInstaller sidecar packs torch + the TTS engines),
// so one installer type per platform keeps compression time sane.
//
// Updater artifacts are disabled for CI (scripts/ci-disable-updater.py): the
// conf pins an updater pubkey + createUpdaterArtifacts, which otherwise makes
// tauri block on a signing-key password prompt and error when the bundle target
// isn't updater-enabled (e.g. .deb).
//
// Agent toolchains:
//   Linux  `pockeo-linux`   — /home/jenkins toolchains; `just` + python3 present.
//   macOS  `macos` (mbook)  — runs as jenkins; force HOME=/Users/jenkins; Python
//                              3.12 via uv (brew unwritable); bun in workspace home.
//   Windows `pockeo-windows`— cmd/`bat` (the `powershell` step isn't on PATH there);
//                              uv + bun pre-provisioned; Python 3.12 via uv.

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
                            # The default (CPU) sidecar must NOT ship the ~2.7GB CUDA/NVIDIA
                            # libs that plain `torch` pulls on Linux (torch x.y+cuNNN). Swap to
                            # CPU torch + drop orphaned nvidia-* wheels so the .deb is ~0.5GB
                            # not 2.5GB. (CUDA users get the separate voicebox-server-cuda.)
                            backend/venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu --force-reinstall torch torchaudio
                            backend/venv/bin/pip freeze | grep -iE '^nvidia[-_]' | cut -d'=' -f1 | xargs -r backend/venv/bin/pip uninstall -y || true
                            just build-server
                            python3 scripts/ci-disable-updater.py
                            ( cd tauri && bun run tauri build --bundles deb < /dev/null )
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

                            rm -rf backend/venv
                            uv venv --python 3.12 --seed backend/venv
                            backend/venv/bin/python -m pip install --upgrade pip
                            backend/venv/bin/pip install -r backend/requirements.txt
                            bun install
                            ./scripts/build-server.sh
                            backend/venv/bin/python scripts/ci-disable-updater.py
                            ( cd tauri && bun run tauri build --bundles dmg < /dev/null )
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
                // cmd/bat (the Jenkins `powershell` step's launcher can't find
                // powershell.exe on these agents — PockeoR uses bat too). uv + bun
                // are pre-provisioned in C:\Users\pockeo.
                stage('Windows') {
                    agent { label 'pockeo-windows' }
                    options { retry(count: 2, conditions: [agent(), nonresumable()]) }
                    steps {
                        checkout scm
                        bat '''
                            set "PATH=%USERPROFILE%\\.local\\bin;%USERPROFILE%\\.cargo\\bin;%USERPROFILE%\\.bun\\bin;C:\\Program Files\\Git\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\nodejs;C:\\Strawberry\\perl\\bin;C:\\LLVM\\bin;%PATH%"
                            uv --version || exit /b 1
                            bun --version || exit /b 1
                            rustc --version || exit /b 1

                            if exist backend\\venv rmdir /S /Q backend\\venv
                            uv venv --python 3.12 --seed backend\\venv || exit /b 1
                            backend\\venv\\Scripts\\python.exe -m pip install --upgrade pip || exit /b 1
                            backend\\venv\\Scripts\\pip.exe install -r backend\\requirements.txt || exit /b 1
                            REM build-server.sh auto-installs PyInstaller on unix; do it explicitly here
                            backend\\venv\\Scripts\\pip.exe install pyinstaller || exit /b 1
                            REM CPU sidecar: swap CUDA torch for the CPU build (smaller + correct)
                            backend\\venv\\Scripts\\pip.exe install --index-url https://download.pytorch.org/whl/cpu --force-reinstall torch torchaudio || exit /b 1
                            call bun install || exit /b 1
                            backend\\venv\\Scripts\\python.exe scripts\\ci-disable-updater.py || exit /b 1

                            set "PATH=%CD%\\backend\\venv\\Scripts;%PATH%"
                            python backend\\build_binary.py || exit /b 1
                            for /f "delims=" %%i in ('rustc --print host-tuple') do set "TRIPLE=%%i"
                            if not exist tauri\\src-tauri\\binaries mkdir tauri\\src-tauri\\binaries
                            copy /Y backend\\dist\\voicebox-server.exe "tauri\\src-tauri\\binaries\\voicebox-server-%TRIPLE%.exe" || exit /b 1
                            python backend\\build_binary.py --shim || exit /b 1
                            copy /Y backend\\dist\\voicebox-mcp.exe "tauri\\src-tauri\\binaries\\voicebox-mcp-%TRIPLE%.exe" || exit /b 1

                            cd tauri || exit /b 1
                            call bun run tauri build --bundles nsis || exit /b 1
                        '''
                    }
                    post {
                        success {
                            archiveArtifacts artifacts: 'tauri/src-tauri/target/release/bundle/nsis/*.exe',
                                allowEmptyArchive: true, fingerprint: true
                        }
                        cleanup {
                            bat 'if exist tauri\\src-tauri\\target\\release\\bundle rmdir /S /Q tauri\\src-tauri\\target\\release\\bundle'
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
