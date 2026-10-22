# Install Reolink TV on a Samsung S90C

## Preview your cameras before TV installation

Run `npm run dev` from the project directory, then open http://127.0.0.1:4173/?connect=1 on this computer. Enter your NVR's local address and select **Check address**. If the recorder requires HTTPS, the address updates automatically. If its certificate needs approval, review the recorder address and fingerprint and select **Trust this certificate** only for your own recorder on your trusted home network. Then enter the recorder login and connect. Approval lasts until the preview server stops and applies only to that address, port, and certificate. No password is sent during the address/certificate check.

The browser preview uses the real NVR for snapshots and live video, including simultaneous feeds in the full-screen grid; it does not need Samsung signing. Leave the preview server running and keep the computer on the NVR's network. The local bridge is included so the NVR does not need to support browser CORS headers. Restart `npm run dev` and reload the page after updating the server code.

## 1. Prepare the recorder

1. Find the NVR's LAN IP address in its Network settings.
2. Enable HTTP (or HTTPS with a certificate trusted by the TV) and RTMP in **Network → Advanced → Server Settings**. Depending on firmware, these settings may appear as a Ports page.
3. Note the HTTP/HTTPS port if it is not the default 80/443. You can enter `http://192.168.1.100:8080` in the TV app.
4. Use the **NVR's** username/password, not individual camera logins and not your Reolink cloud-account password.
5. Start with Fluent video. The app will read the NVR's RTMP port when permitted; Connection options also has an override.

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

Enter the NVR address, username, and password. Select **Connect to NVR**. The app discovers channels and opens the snapshot overview. Select **Full screen** for a live grid, or select a camera to view it alone. The live grid uses muted Fluent streams; choose a smaller layout if the TV or NVR cannot sustain all visible feeds. Actual S90C multi-stream capacity still needs hardware testing. Password persistence is off by default; enable it only if you want it stored in this TV app's local data.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Cannot reach NVR | Confirm IP, HTTP/HTTPS port, same network, and enabled HTTP service. A cloud UID is not a LAN address. |
| Browser preview reports 502 | Restart `npm run dev` after updating and reload the page for the specific error. Check the NVR's enabled HTTP/HTTPS port; 502 alone is not a password rejection. |
| Preview session unavailable | Reload after restarting the preview server; each run has a new local connection key. |
| NVR connection refused | Check the NVR address and its HTTP/HTTPS service in Server Settings. Use the configured web port, not Basic Service, RTSP, or RTMP. |
| Recorder redirected the request | Check address automatically handles the same recorder's HTTP-to-HTTPS redirect, including redirects to its HTTPS home page. A known older CGI-path redirect is also handled automatically. |
| Sign-in rejected | Use the local NVR login and check permissions. The app does not repeatedly retry an incorrect password. |
| Browser asks to approve a certificate | Review the exact recorder address and certificate. Trusting it allows only that certificate for that HTTPS origin during the current preview-server session. A change requires a new approval. |
| HTTPS fails on the installed TV | The TV must trust the NVR certificate. Desktop-preview approval does not carry over to the TV. Use a TV-trusted certificate or intentionally use the recorder's enabled HTTP service on your trusted LAN. |
| No camera list | Enable manual channel count in Connection options; displayed channel 1 maps to Reolink API channel 0. |
| Snapshot works but video fails | Enable RTMP on the NVR, check the RTMP port, use Fluent quality, and try NVR credentials under Stream sign-in. |
| Clear fails but Fluent plays | Your main stream may be H.265. This direct HTTP-FLV path targets H.264; do not lower NVR recording settings unless you want that separate change. |
| Desktop connection is blocked but TV works | Use `npm run dev` and its local preview URL so the bridge handles CORS. Check the computer's network route, firewall, VPN, and terminal app's local-network access. |
| Camera shows Sleeping | Wake a battery camera in Reolink and retry. The app avoids continuous polling of sleeping cameras. |
| Install says certificate/DUID invalid | Reissue the distributor certificate with this TV's DUID and permit installation in Device Manager. |
| Update signature mismatch | Sign with the original author certificate. Removing a previous install can erase app settings. |
| TV not found by SDB | Check Developer Mode host IP, TV IP/port, LAN connectivity, and the Mac's local-network permissions. |

## Remaining device validation

Confirm the TV's current Tizen firmware, NVR model/firmware, channel list, HTTP-FLV authentication behavior, stream codec, audio codec, and TV on-screen keyboard behavior during the first hardware run. Browser decoding tests do not prove Samsung hardware compatibility.
