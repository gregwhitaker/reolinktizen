# Reolink TV

A local Reolink NVR viewer for Samsung Tizen TVs, targeting the **Samsung S90C / Tizen 7.0 or newer**. Independent app; not affiliated with Reolink or Samsung.

## What it does

- Connects directly to your NVR over the local network using its Reolink HTTP API.
- Discovers camera names and channel numbers, including offline/sleeping status.
- Displays an adjustable **snapshot overview**: Auto, 1, 2, 4, 6, 8, 9, 10, 13, 14, 16, or 25 cameras per page, with pagination for up to 64 channels.
- Includes larger featured-camera arrangements and both side-by-side and stacked two-camera views.
- Expands any overview layout into a **full-screen live multi-camera view**, with a muted Fluent stream per online tile, independent reconnects, and controls that hide when idle.
- Opens a selected camera on its own with quality and audio controls through bundled mpegts.js / Media Source Extensions.
- Supports remote arrows, Select, Back, channel switching, favorites, audio, and timed camera cycling.
- Uses neutral charcoal surfaces and white focus highlights throughout the interface.
- Renews API sessions, retries interrupted streams, and falls back from Clear to Fluent video.
- Pauses streaming and polling when the app is hidden; resumes when it becomes visible.
- Has an explicitly labeled illustration demo that works without an NVR.
- Can preview real NVR snapshots and live video in a desktop browser through a local connection bridge.
- Makes no cloud requests and loads no remote scripts, analytics, or fonts.

**Status:** First implementation. Automated tests and a local browser / simulated-NVR check are provided. Playback on your actual S90C and NVR still needs hardware validation. The supplied widget is **unsigned**, so it is **not installable on a stock TV until signed** with a Samsung TV certificate profile containing your TV's DUID. The Mac used to build this did not have Tizen Studio installed.

## Preview with your real NVR

Requires Node.js 20+; no npm install step or runtime server dependency for the TV app.

```sh
npm run dev
```

Open http://127.0.0.1:4173/?connect=1 in a Chromium browser. Enter your **NVR's local IP address** and select **Check address**. The preview checks the Reolink API without a password and switches to HTTPS if the same recorder requires it. If its HTTPS certificate is self-signed or does not match its IP address, review the certificate panel and select **Trust this certificate** only if this is your recorder on your trusted home network. Then enter your **NVR username and password** and select **Connect to NVR**. Enable HTTP or HTTPS and RTMP on the NVR; use Fluent quality to start. No TV installation or Samsung signing is needed for this browser preview.

The dashboard displays current snapshots from your cameras. Select **Full screen** for simultaneous live feeds in the current layout, or select one camera to expand it. The same layout controls, favorites, and camera cycling work here.

The preview server relays Reolink API, snapshot, and HTTP-FLV requests between the browser and your local NVR, avoiding browser cross-origin restrictions. Live video uses one WebSocket per feed so long-running streams do not exhaust the browser's HTTP connection pool or block API requests. The server listens only on loopback, requires a per-run key and matching origin, and accepts only local destinations and Reolink endpoints. Credentialed requests never follow redirects. The server does not log or save NVR credentials. Password persistence in the browser remains opt-in. Keep `npm run dev` running while using the preview. The packaged TV app connects directly and does not need this server. Restart the preview server and reload the page after updating to 0.1.9.

Certificate approval applies to **one exact HTTPS address, port, and certificate fingerprint**, lasts only until the preview server stops, and does not modify your computer's trust store. The review step performs a TLS handshake without sending an HTTP request or login. After explicit approval, NVR requests validate the approved certificate and its expiry, and reject a changed certificate before transmitting login data. Certificates that are expired or not yet valid cannot be approved. This approval flow belongs to the desktop preview; the installed TV must separately trust the recorder's HTTPS certificate or use its enabled HTTP service.

If connecting reports **502**, the preview could not complete the NVR request; that status alone does not mean the password is wrong. Version 0.1.5 shows separate messages for a refused port, an untrusted HTTPS certificate, a hostname lookup failure, a network timeout, and a protocol mismatch. After updating, stop the old server with **Ctrl+C**, run `npm run dev` again, and reload the preview. Use the NVR's enabled **HTTP/HTTPS** port from Network → Advanced → Server Settings, not its Basic Service or RTSP port. You can check that same address in a browser to see whether the recorder's own sign-in page loads.

Version 0.1.7 handles Reolink firmware that redirects every HTTP request to the HTTPS home page, dropping the API path. The password-free address check preserves the API path while switching to that HTTPS origin. Cross-host redirects are not followed. A redirect from `/api.cgi` to the same origin's `/cgi-bin/api.cgi` uses the existing older-firmware login fallback automatically.

For illustration-only UI exploration, `http://127.0.0.1:4173/?demo=1` remains available. It does not connect to cameras. Actual playback on the S90C still requires separate hardware validation.

## Adjust the camera overview

Select the **⊞ layout button** beside Cycle on the overview, use the remote arrows to choose a layout, and press **OK**. **Auto** picks the smallest layout that fits the current All cameras or Favorites list, up to 25 per page. Choose from these 12 arrangements; additional cameras use the page arrows at the bottom.

| Cameras per page | Arrangement |
| --- | --- |
| 1, 4, 9, 16, 25 | Equal-size tiles |
| 2 | Side by side or stacked |
| 6, 8, 13 | One large camera with smaller surrounding tiles |
| 10 | Two large cameras above eight smaller tiles |
| 14 | One largest and one medium camera with 12 smaller tiles |

The first camera on a page fills its largest tile; the second fills the other featured tile in the 10- and 14-camera layouts. Remaining cameras follow NVR channel order.

The app remembers this preference, including changes made in the demo. Changing layouts keeps the first camera on your current page in view. Previews preserve the entire camera frame without cropping. Featured cameras use larger tiles; smaller tiles use compact labels. Selecting any tile still opens its full-screen live stream.

### Full-screen multi-camera view

Select **⛶ Full screen** beside the layout button, press **F** on a keyboard, or press the remote's **Green** button from the overview. The current layout fills the TV, preserving your page and All cameras/Favorites filter. On desktop, the app also requests browser fullscreen when supported; if the browser refuses, the grid still fills the app viewport.

The floating controls provide a live-camera count, layout selection, page arrows, and **Exit full screen**, and disappear after five seconds of inactivity. Move the pointer or press an arrow key to reveal them. **Info** focuses the exit button; **CH + / −** changes grid pages. Select a camera to expand it and access sound/quality controls, then press **Back** to return to the same full-screen grid. Press **Back** again (or **F**, **Green**, or **Exit full screen**) to restore the dashboard. Browser **Escape** may also leave native fullscreen directly.

Every online, awake tile plays its own **live Fluent (H.264 substream)** video with audio disabled. Changing pages, opening one camera, leaving fullscreen, or hiding the app releases streams that are no longer visible. Layout changes retain healthy streams for cameras that stay on screen. Failed tiles retry independently and then show **Unavailable**; **Retry unavailable** restarts only those feeds. Offline and sleeping cameras retain their status. Demo mode remains explicitly labeled illustrations.

The browser was checked with 24 simultaneous decoded test feeds in a 25-tile layout. The physical S90C's decoder capacity and recorder connection limits have not been verified; 25 live cameras on the TV are not guaranteed. If feeds become unavailable, choose a smaller layout or open a camera on its own. Large live layouts consume more network bandwidth and decoding resources than the snapshot dashboard.

## Build and install

```sh
npm test
npm run package
npm run doctor
```

Builds `dist/`, `artifacts/ReolinkTV-unsigned.wgt`, and `artifacts/ReolinkTV-source.zip`. Packaging requires Python 3.

After installing Tizen Studio and creating a Samsung TV certificate profile:

```sh
npm run sign -- --profile YOUR_SAMSUNG_TV_PROFILE
npm run install:tv -- --tv YOUR_TV_IP
```

Signing produces `artifacts/ReolinkTV.wgt`. The installation command connects to SDB, installs that signed widget, and launches `ReolinkTV1.Viewer`. It does not root the TV or change its firmware.

Follow [the S90C installation guide](docs/INSTALL.md) for certificates, Developer Mode, NVR setup, and troubleshooting. Root access is not required.

## NVR compatibility

Enable **HTTP or trusted HTTPS** and **RTMP** under the NVR's network/server settings. Menu names differ by firmware. Fluent (`channelN_sub.bcs`) is the default and best starting point.

Reolink documents HTTP-FLV for H.264 streams. Many 8MP/12MP cameras use H.265 for their main stream, so their highest-resolution Clear stream is outside this version's reliable direct-streaming path. The app falls back to the H.264 substream. It does not change the camera's recording resolution.

Automatic stream authentication first tries the API session token, then the documented username/password FLV URL for firmware that needs it. You can select either mode in Connection options. Firmware behavior with special characters in legacy FLV credentials needs device testing; credentials are URL-encoded, never concatenated without escaping.

This version does **not** implement recording playback, two-way talk, PTZ, push notifications, or an RTSP/HEVC relay. The dashboard uses refreshed still images with two snapshot requests at a time; fullscreen uses live streams. Battery cameras asleep on the NVR are shown as sleeping and are not polled or streamed until reported awake.

## Remote

| Input | Action |
| --- | --- |
| Arrows | Move focus; left/right switch cameras when full-screen controls are hidden |
| Select / OK | Activate the focused control or show full-screen controls |
| Back | Return from a camera to its grid; leave full-screen grid; exit confirmation from dashboard |
| CH + / − | Next / previous camera in live view; next / previous page in full-screen grid |
| Play/Pause | Pause the current feed; resume at the live edge |
| Stop | Return to overview |
| Yellow | Toggle favorite while viewing |
| Green / keyboard F | Toggle full-screen multi-camera view from the grid |
| Blue | Toggle camera cycling while viewing |
| Info | Show live-camera controls; focus Exit in the full-screen grid |

On the TV, select a text field to open editing and use Done/Back to return to navigation. TV IME behavior is part of the remaining hardware validation. A USB or Bluetooth keyboard also works. In the browser, use normal typing and arrow/Enter/Escape keys.

## Credentials and local data

Credentials go only to the NVR address you enter. The API login uses a POST body; video uses a token when supported. Legacy FLV authentication necessarily places credentials in the request query string. Player library logging is disabled to avoid printing those URLs.

Passwords stay in memory by default. **Remember password on this TV** is opt-in and stores the password in app-local storage, not an encrypted credential vault. Use a dedicated view-only NVR account if your firmware supports one. Settings → Connection options → Forget saved connection removes saved data. Plain HTTP is unencrypted; use it only on your trusted LAN. The desktop preview supports explicit certificate approval as described above. Self-signed HTTPS certificates may still be rejected by the installed TV app; desktop approval does not change TV trust settings.

## Project structure

| Path | Purpose |
| --- | --- |
| `app/` | Complete packaged TV application |
| `app/js/api.js` | Reolink login, discovery, snapshots, stream URLs |
| `app/js/player.js` | Per-camera decoder lifecycle and bounded reconnects |
| `app/js/live-grid.js` | Visible live-camera reconciliation and independent retries |
| `app/js/preview-stream.js` | Browser WebSocket-to-stream adapter |
| `app/js/app.js` | Screens, remote control, favorites, app lifecycle |
| `app/vendor/` | Pinned mpegts.js 1.8.2 and its Apache-2.0 license |
| `scripts/` | Preview, packaging, Samsung signing/install helpers |
| `scripts/preview-streams.mjs` | Protected WebSocket relay using the existing NVR bridge |
| `scripts/vendor/ws/` | Bundled ws 8.22.0 and MIT license for the desktop preview |
| `tests/` | Node built-in tests; no test framework installation needed |
| `docs/` | Installation and validation notes |

## References

- [Reolink HTTP-FLV streaming and H.264 limitations](https://support.reolink.com/articles/28256840140441-Introduction-to-FLV-Stream/)
- [Samsung TV general specifications](https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html)
- [Samsung TV device / Developer Mode setup](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)
- [Samsung TV CLI build, signing, installation](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/command-line-interface.html)
- [mpegts.js source and API](https://github.com/xqq/mpegts.js)

Project code is MIT licensed. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled software.
