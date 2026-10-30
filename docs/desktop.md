# Desktop client

Bakery's Tauri 2 client opens an existing Bakery server in the operating system's webview. It does not bundle Chromium, Node, Git, Pi, or a local server. Repositories and agents stay on the server. Closing the app does not stop runs.

The client targets macOS, Windows, and Linux. The Linux native build and smoke test have been exercised. macOS and Windows still need native build and interaction checks before release. There are no signed installers or automatic updates yet.

## Connect

1. Join the server's Tailnet or trusted private network.
2. Open Bakery and enter the server origin, such as `https://bakery.example.ts.net` or `http://100.64.0.10:4317`. Do not include a board path.
3. For HTTP outside loopback, explicitly allow unencrypted HTTP. Use HTTPS if traffic is not already protected by your private network.
4. Click **Connect**. The client checks `/api/status` and confirms that the root serves HTML before opening the server.

The client remembers the last validated address. It does not automatically reconnect on launch. Use **Bakery > Connection settings** (`Cmd/Ctrl+,`) to switch servers, **Reload Bakery** (`Cmd/Ctrl+R`) to recover after a server restart, or **Open in browser** to leave the webview. External links, popup links, and HTTP(S) downloads open in your system browser. Custom URL schemes and blob downloads are not supported.

The server must serve both the API and frontend at the same origin. On the server, build the web UI and run with `BAKERY_SERVE_UI=1`. For example, after replacing the example Tailnet address and hostname:

```sh
npm run build
BAKERY_SERVE_UI=1 \
  BAKERY_HOST=100.64.0.10 \
  BAKERY_ALLOWED_HOSTS=bakery.example.ts.net \
  npm start
```

Use your existing service manager for a persistent server. Binding to a Tailnet address avoids exposing the listener on every network interface. HTTPS requires an HTTPS endpoint in front of Bakery, such as Tailscale Serve.

Bakery has no application authentication. The desktop client does not add any. Keep the server behind Tailnet access controls or another trusted boundary, not on the public internet. The first version supports direct connections, not interactive proxy login redirects, client certificates, self-signed certificates, or subpath deployments. The native health check does not share browser cookies.

If the server returns 403, add the hostname to `BAKERY_ALLOWED_HOSTS`. If the API works but the UI does not, enable `BAKERY_SERVE_UI=1` and build the frontend. A server going offline after connection can show the webview's error page; the native connection menu remains available.

## Run and build

Install Node 24+, Rust, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). These include Xcode tools on macOS, MSVC build tools and WebView2 on Windows, and GTK 3/WebKitGTK 4.1 development packages on Linux. A Linux build also needs the packaging dependencies listed by Tauri if you want installers.

```sh
npm ci
npm run desktop:dev
```

This runs only the desktop client. Start Bakery separately. In local development, connect to `http://127.0.0.1:5173`, where Vite proxies the API. The API-only development port is not a valid client destination.

Build on each target operating system:

```sh
npm run desktop:build
```

Installers appear under `src-tauri/target/release/bundle/`. For an unbundled debug executable, use `npm run desktop:build -- --debug --no-bundle`. Production distribution still requires platform signing and macOS notarization.

## Test Windows from a headless server

The `Windows desktop installer` GitHub Actions workflow builds an unsigned x64 NSIS installer on `windows-latest`. It runs the Rust tests on Windows and uploads the installer as an artifact for 14 days. It does not publish a release or require signing secrets. A successful build does not verify desktop interactions.

1. Push the branch containing `.github/workflows/desktop-windows.yml` and the desktop client. Changes to the workflow, desktop files, Rust files, or npm dependency files trigger a build on any branch.
2. On GitHub, open **Actions > Windows desktop installer** and select the run for your commit.
3. After the run succeeds, download the `bakery-windows-x64-<commit>` artifact on your Windows PC, extract the ZIP, and run the `.exe` installer. Windows may warn because the installer is unsigned. Only run an artifact from your own trusted build. If WebView2 is missing, the installer downloads its runtime.

Once the workflow is on the repository's default branch, you can also use **Run workflow** and choose a branch. For the first branch-only build, use the push trigger; the manual-run button might not be available yet.

You do not need Node, Rust, or Visual Studio on your Windows PC to run the installer. To connect through SSH, run this in a separate Windows PowerShell window and keep it open:

```powershell
ssh -N -L 4317:127.0.0.1:4317 your-user@your-server
```

Enter `http://127.0.0.1:4317` in the desktop client. This assumes the server serves both the API and built UI on port 4317. If the server runs `npm run dev`, forward to the supervisor's public UI port instead. Port 5173 proxies Vite's internal port 15173:

```powershell
ssh -N -L 4317:127.0.0.1:5173 your-user@your-server
```

The desktop address stays `http://127.0.0.1:4317`. The loopback HTTP connection travels through the encrypted SSH tunnel. No public listener or extra allowed hostname is needed.

On Windows, check that you can connect, drag cards between lanes, upload and download attachments, open external links, switch servers, and recover through **Connection settings** after closing the Bakery window. Avoid starting agent runs unless you intend to use paid model tokens.

## Tests

```sh
npx playwright install chromium
npm run desktop:test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The Rust tests cover server validation, navigation boundaries, persisted settings, and real HTTP probe responses. The Playwright tests cover the connection form with a mocked native-command boundary.

The optional native smoke test needs Linux, a recent `xdotool` with `windowquit`, an isolated X11 display with a window manager, and a built debug executable. For example, with Xvfb and Xfwm4 installed:

```sh
npm run desktop:build -- --debug --no-bundle
xvfb-run -a sh -c '
  xfwm4 --compositor=off & wm=$!
  node --test tests/desktop-native.test.mjs
  result=$?
  kill "$wm"
  exit "$result"
'
```

Do not run it against your working desktop. It moves focus and clicks windows. `BAKERY_DESKTOP_BINARY` can select another debug binary or a wrapper. The test uses a temporary server and settings directory, checks native command denial from the remote page, switches origins, reconnects repeatedly, and intercepts system-browser launches without opening a real browser. It also checks recovery after closing each window and verifies that closing the last visible window exits the app.

## Native boundary

`desktop/` contains the bundled connection form. Only its `connection` window gets the `connect` and `saved_server` commands. That window cannot navigate to remote content.

The server UI runs in a separate window with no Tauri capability grants. Tauri may inject its IPC bridge into remote pages, but those pages are not authorized to call native commands. Server navigation stays on the selected origin. Other HTTP(S) destinations go to the system browser through native callbacks. These navigation rules are not a network firewall: the hosted application can still make web requests and embed resources allowed by its webview.

Do not add `remote.urls`, broad window wildcards, or opener permissions to the connection capability. An empty capability list is not a deny-all setting in Tauri. The configuration deliberately names only `connection`.
