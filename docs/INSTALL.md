# Install Reolink TV on a Samsung S90C

## Preview your cameras before TV installation

Run `npm run dev` from the project directory, then open http://127.0.0.1:4173/?connect=1 on this computer. Enter your NVR IP address, username, and password, then select **Connect**. HTTPS is assumed; you do not need to type `https://`. The address check runs automatically. If the recorder requires HTTPS, the address updates automatically. The preview always accepts local NVR certificates, including changed or expired ones, and continues directly to login without an approval message. No password is sent during the initial address check. HTTPS remains encrypted, but certificate identity and validity are not verified for these local NVR requests.

The browser preview uses the real NVR for overview snapshots and full-screen live video; it does not need Samsung signing. Leave the preview server running and keep the computer on the NVR's network. The local bridge is included so the NVR does not need to support browser CORS headers. Restart `npm run dev` and reload the page after updating the server code.

An empty IP field starts a short LAN search automatically. One identified NVR fills the field; otherwise select a discovered device or type the IP. **Search again** retries. Searches preserve saved and typed addresses and send no credentials. Enable ONVIF on the NVR for discovery; discovery itself does not use HTTPS. The desktop preview accepts local NVR certificates automatically; the installed TV retains its platform's HTTPS handling.

## 1. Prepare the recorder

1. Find the NVR's LAN IP address in its Network settings.
2. Enable HTTP (or HTTPS with a certificate trusted by the TV) and RTMP in **Network → Advanced → Server Settings**. Depending on firmware, these settings may appear as a Ports page.
3. Note the HTTP/HTTPS port if it is not the default 80/443. You can enter `http://192.168.1.100:8080` in the TV app.
4. Use the **NVR's** username/password, not individual camera logins and not your Reolink cloud-account password.
5. The app starts with Fluent video and reads the NVR's RTMP port when permitted.
6. Enable **ONVIF** in Server Settings for automatic discovery. UDP multicast on port 3702 must reach the recorder on the same LAN. Its ONVIF service port (often 8000) is separate from its HTTPS web port; the app does not substitute that port for HTTPS.

The TV only needs to reach the NVR. PoE cameras on the NVR's private camera network do not have to be individually reachable from the TV. Guest-Wi-Fi/client isolation can prevent access.

## 2. Install Samsung development tools

Install [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download) and the **Samsung TV Extension** and **Samsung Certificate Extension** in its Package Manager. Samsung's tooling/platform support changes; follow the current vendor installation instructions for your Mac.

The helper discovers `~/tizen-studio/tools/ide/bin/tizen` and `~/tizen-studio/tools/sdb`. For other locations:

```sh
export TIZEN_CLI="/absolute/path/to/tizen-studio/tools/ide/bin/tizen"
export SDB="/absolute/path/to/tizen-studio/tools/sdb"
npm run doctor
```

It also detects the SDB binary at `~/s90c-root/data/tools/sdb` if already present. Having SDB alone is not sufficient to sign an app.

### Build the TV's discovery module

The TV uses Samsung's **Tizen Sockets Extension** in a Web Worker to send and receive ONVIF UDP packets directly. It does not call the desktop preview for discovery. The installed app needs the compiled runtime, but the TV needs no compiler or external server.

Install **Samsung Emscripten SDK 1.39.4.7** for your build computer from [Samsung's download page](https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/download.html), then [activate the SDK](https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/getting-started/downloading-and-installing.html) with `./emsdk activate latest-fastcomp` in the extracted `emscripten-release-bundle/emsdk` directory. Stock Emscripten does not include Samsung's native socket extension.

From this project:

```sh
export SAMSUNG_EMCC="/absolute/path/to/emscripten-release-bundle/emsdk/fastcomp/emscripten/emcc"
npm run build:discovery
npm run package
```

The build writes `tizen-discovery.js`, `tizen-discovery.wasm`, the SDK's license, and a source/output hash manifest into `app/vendor/discovery/`. Include these generated files when distributing the app. Packaging and signing verify the manifest and rebuild changed/missing output if `SAMSUNG_EMCC` is set; otherwise they stop with setup instructions. This prevents producing a widget that silently omits TV discovery. Run this step before importing `app/` directly into the IDE, too.

The compiler was unavailable in the implementation environment, so the native module has **not yet been compiled or validated on a TV**. The C source passes a host Clang syntax check, and the worker transport is covered by simulated socket tests. Tizen 7's older Chromium needs `unsafe-eval` in the widget's script policy to compile WebAssembly; scripts still load only from the app package. Actual compilation, signing, discovery and remote navigation on the S90C remain release checks.

## 3. Connect the TV in Developer Mode

1. Connect the Mac and S90C to the same network.
2. Open the TV's **Apps** screen (on some firmware, its App Settings screen).
3. Enter **12345** using the remote number keypad to open Developer Mode.
4. Enable Developer Mode and enter your **Mac's LAN IP address** as the development host.
5. Reboot the TV.
6. In Tizen Studio Device Manager, add the TV's IP with port **26101** and connect.

If this is already configured, keep the existing configuration. No root session or firmware modification is needed.

## 4. Create a Samsung TV signing certificate

Use **Tools → Certificate Manager** to create a **Samsung / TV** certificate profile. Sign into your own Samsung account when prompted. Add your connected TV's **DUID** to the distributor certificate. Keep the certificate's author key backed up; updates should use the same author identity.

Use Device Manager's **Permit to install applications** action for the TV if required. A generic Tizen certificate or an unsigned ZIP renamed `.wgt` does not replace the Samsung TV signing requirement.

The generated `ReolinkTV-unsigned.wgt` is provided as build output for inspection. It cannot be directly installed on a stock S90C. Do not send certificate passwords or private keys in chat.

## 5. Sign, install, and launch

From the project directory:

```sh
npm test
npm run sign -- --profile YOUR_SAMSUNG_TV_PROFILE
npm run install:tv -- --tv YOUR_TV_IP
```

For example, replace `YOUR_TV_IP` with the TV's actual current address, and replace the profile name with the one in Certificate Manager.

These commands invoke Samsung's CLI using argument arrays rather than a shell command assembled from your inputs. Installation explicitly refuses the unsigned archive. If launch fails after a successful install, open **Reolink TV** from Apps, or run:

```sh
"$TIZEN_CLI" run -s YOUR_TV_IP:26101 -p ReolinkTV1.Viewer
```

For manual IDE use, import `app/` as an existing Tizen web application, select the Samsung certificate profile, and run it on the connected TV. The application ID is `ReolinkTV1.Viewer`, and package ID is `ReolinkTV1`.

## 6. Connect in the app

Enter the NVR IP address, username, and password. HTTPS is assumed. Select **Connect**. The app discovers channels and shows snapshot previews, refreshed every five seconds by default. Select **Full screen** to start muted Fluent streams for the grid, or select a camera to watch it live on its own. Exiting fullscreen stops the grid streams and resumes snapshots. Choose a smaller fullscreen layout if the TV or NVR cannot sustain all visible feeds. Actual S90C multi-stream capacity still needs hardware testing. Passwords stay in memory by default; any previously saved password preference is preserved.

The TV searches automatically when the address is blank. Use the remote arrows and OK to choose a discovered recorder or **Search again**. A single identified recorder fills the address without moving focus. You can always enter the IP yourself. Searches stop when connecting, leaving setup, or hiding the app.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Cannot reach NVR | Confirm IP, HTTP/HTTPS port, same network, and enabled HTTP service. A cloud UID is not a LAN address. |
| No NVR found | Enable ONVIF on the recorder, use the same LAN, and check multicast/client isolation. Recorders on another VLAN and ONVIF-disabled devices need manual IP entry. |
| TV discovery could not start | Check the TV network connection and rebuild/reinstall with the Samsung discovery module. Browser preview alone does not supply the TV runtime. |
| Browser preview reports 502 | Restart `npm run dev` after updating and reload the page for the specific error. Check the NVR's enabled HTTP/HTTPS port; 502 alone is not a password rejection. |
| Preview session unavailable | Reload after restarting the preview server; each run has a new local connection key. |
| NVR connection refused | Check the NVR address and its HTTP/HTTPS service in Server Settings. Use the configured web port, not Basic Service, RTSP, or RTMP. |
| Recorder redirected the request | Connecting automatically handles the same recorder's HTTP-to-HTTPS redirect, including redirects to its HTTPS home page. A known older CGI-path redirect is also handled automatically. |
| Sign-in rejected | Use the local NVR login and check permissions. The app does not repeatedly retry an incorrect password. |
| Browser still asks to approve a certificate | Stop the old preview server with Ctrl+C, run `npm run dev` again, and reload the page. The current preview always accepts local NVR certificates and has no approval panel. |
| HTTPS fails on the installed TV | The TV must trust the NVR certificate. The desktop preview's automatic acceptance does not carry over to the TV. Use a TV-trusted certificate or intentionally use the recorder's enabled HTTP service on your trusted LAN. |
| No camera list | Check that cameras appear in the NVR and that the account can view them; displayed channel 1 maps to Reolink API channel 0. |
| Snapshot works but video fails | Enable RTMP on the NVR and use Fluent quality. Stream sign-in automatically tries token and credential authentication. |
| Clear fails but Fluent plays | Your main stream may be H.265. This direct HTTP-FLV path targets H.264; do not lower NVR recording settings unless you want that separate change. |
| Desktop connection is blocked but TV works | Use `npm run dev` and its local preview URL so the bridge handles CORS. Check the computer's network route, firewall, VPN, and terminal app's local-network access. |
| Camera shows Sleeping | Wake a battery camera in Reolink and retry. The app avoids continuous polling of sleeping cameras. |
| Install says certificate/DUID invalid | Reissue the distributor certificate with this TV's DUID and permit installation in Device Manager. |
| Update signature mismatch | Sign with the original author certificate. Removing a previous install can erase app settings. |
| TV not found by SDB | Check Developer Mode host IP, TV IP/port, LAN connectivity, and the Mac's local-network permissions. |

## Remaining device validation

Confirm the TV's current Tizen firmware, NVR model/firmware, channel list, HTTP-FLV authentication behavior, stream codec, audio codec, and TV on-screen keyboard behavior during the first hardware run. Browser decoding tests do not prove Samsung hardware compatibility.
