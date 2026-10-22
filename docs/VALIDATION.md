# Validation — 22 October 2026

## Automated checks

`npm test` runs Node's built-in test runner. Sixty-two tests cover:

- Host/port validation and rejection of embedded credentials and URL paths.
- Camera channel indexing, deduplication, offline status, and sleeping status.
- POST-body login, single-flight authentication, camera discovery, and RTMP-port discovery.
- Correct escaping of reserved characters in legacy stream URLs.
- Expired/rejected-session renewal with concurrent callers.
- No retry storm after an incorrect password; safe error messages.
- Legacy `/cgi-bin/api.cgi` fallback.
- Snapshot authentication recovery and JPEG content-type normalization.
- Client cancellation and password removal on close.
- Opt-in password persistence and corrupt-settings recovery.
- Discarding late camera-open results; one decoder instance at a time.
- Token/credential and Clear/Fluent fallbacks; cancellation of reconnect timers.
- D-pad spatial navigation.
- Two-at-a-time snapshot loading and stale-page result suppression.
- Immediate cancellation of stalled HTTP streams, including their readers.
- Late HTTP responses after cancellation and safe handling of HTTP failures.
- Auto layout selection, complete pagination through 64 channels, and page clamping after filtering.
- Layout preference persistence and migration of missing or invalid values to Auto.
- All 12 layout geometries: expected tile counts, full coverage, no overlap, and featured-camera spans.
- Distinct side-by-side and stacked two-camera layouts, including pagination.
- D-pad reachability of every camera tile in each layout.
- D-pad reachability in the full-screen grid's 1920 × 1080 geometry.
- Full-screen browser support, rejection/absence fallback, browser-driven exit, and prefixed events.
- Back during a pending fullscreen request, re-entry while pending, and preserving unrelated fullscreen sessions.
- Local browser transport: POST-body login, channel discovery, and unchanged JPEG bytes through the bridge.
- Bridge key/origin/Host checks, local destination validation, and endpoint restrictions.
- Immediate forwarding of video bytes and cancellation of the upstream NVR connection when the player closes.
- Credential-header filtering, redirect rejection, and direct transport for the packaged TV app.
- Refused NVR ports reaching the API client as connection failures rather than incorrect-password errors.
- Expired preview keys distinguished from genuine NVR HTTP authentication failures.
- Safe diagnostics for certificate, DNS, routing, protocol, and timeout failures; raw socket messages are not exposed.
- Compatibility with the older running preview, stopped-server guidance, preserved caller cancellation, and rejection of unmarked upstream error text as preview diagnostics.
- Same-recorder redirect guidance with the exact scheme and port, without reflecting tokens, passwords, or arbitrary external addresses.
- Distinct handling of non-API redirects, missing locations, HTTPS downgrades, and redirect loops.
- Automatic use of the existing legacy login fallback for a same-origin redirect to `/cgi-bin/api.cgi`.
- Reolink's HTTP-to-HTTPS-home-page redirect, preserving the API origin during a credential-free check.
- Address checks and certificate inspection never sending a password or granting approval automatically.
- TLS inspection transmitting no HTTP data; an unapproved self-signed certificate blocking login.
- Explicit approval bound to one HTTPS origin and certificate, with rejection after certificate replacement, a port change, or preview-server restart.
- Certificate endpoints rejecting foreign origins, missing keys, nonlocal addresses, and unreviewed/mismatched approvals.
- Live grid reconciliation for up to 25 cameras, excluding offline/sleeping/demo tiles, retaining unchanged players and disposing removed ones.
- Independent per-camera errors, retrying only failed feeds, and ignoring delayed callbacks after disposal.
- Suppression of late stream URLs after leaving the grid, audio-free grid playback, bounded old video buffers, and event-listener cleanup.
- Ignoring errors from obsolete decoders after a reconnect.
- Twenty-five concurrent preview WebSocket streams delivering exact video bytes while API requests remain responsive.
- WebSocket origin/key enforcement, existing target/redirect/header protections, and upstream cancellation before or after headers arrive.

All 62 tests passed with the host Node executable. The network tests require loopback listeners, which the command sandbox does not permit. HTTPS tests use disposable certificates and a fixture key stored under `tests/fixtures`, never a recorder's certificate or credentials. Test fixtures were not shown as real camera footage.

## Browser integration checks

The local UI was exercised in the in-app Chromium browser against `scripts/mock-nvr.mjs`, not a real NVR:

- Setup screen, overview, and full-screen layouts inspected visually at a 1280×720 viewport (the app uses a scaled 1920×1080 canvas).
- Incorrect credentials showed an actionable sign-in error.
- A successful login discovered eight channels; six visible snapshots loaded.
- Right/Down/Enter keyboard navigation moved to the expected camera and started playback.
- An actual FFmpeg-generated H.264/AAC FLV stream decoded at 640×360, with advancing video time and no browser console errors during the observed run.
- Deliberately stalled test media triggered bounded reconnects and an actionable error, then recovered through Retry.
- Returning to overview paused/unloaded the video and removed its media source.
- A library cancellation issue was found and fixed with a custom loader. Repeating the browser check returned the simulated NVR's active video-connection count to **zero** after leaving playback.
- Favoriting a camera showed the star in the overview; Favorites displayed only that camera.
- Reloading with password persistence unchecked returned to login without retaining the password.

The adjustable overview was checked again with the eight-camera demo and a **16-channel simulator**:

- Auto displayed all 16 channels in a 4 × 4 grid; all 15 online snapshots loaded and the offline camera retained its status.
- Layout selection worked using only arrow keys and OK. Grid navigation crossed a 2 × 2 layout and reached camera 16 in a 4 × 4 layout.
- Four cameras per page produced two pages in the demo. Changing page two to one camera per page retained camera 5 on page 5 of 8.
- A nine-camera layout split 16 channels into pages of nine and seven. Opening camera 16 and pressing Back restored its focus on page two.
- A chosen one-camera layout survived reloading. Auto adapted an eight-camera overview to one favorited camera.
- Back dismissed the layout picker without applying the newly focused choice. No browser console errors were observed during these checks.
- Single-camera, eight-camera, and 16-camera overviews and the layout picker were inspected at 1280 × 720. Camera frames use contain sizing, with compact labels on denser layouts.

Version 0.1.2 changes the interface to neutral charcoal and white. The overview, setup screen, and layout picker were visually checked at 1280 × 720, including white focus outlines and selected states; the layout screenshot was refreshed.

Version 0.1.3 matches the 12 arrangements in the supplied layout reference. Browser checks used the eight-camera demo and a **25-channel simulator**:

- The picker displays the reference's four-column, three-row ordering, plus a separate Auto control. All options and the footer fit at 1280 × 720.
- The eight-camera demo displays one large camera with seven smaller surrounding tiles.
- Selecting 25 cameras using the remote arrows and OK displayed a 5 × 5 overview; all 24 online snapshots loaded and the offline camera retained its status.
- The 14-camera view uses a 3 × 3 featured tile and a 2 × 2 secondary tile within a 5 × 5 grid. Its two pages contained 14 and 11 cameras.
- Changing page two of the 14-camera view to the stacked two-camera view retained camera 15, on page 8 of 13.
- Updated screenshots document the picker and featured-camera view in the illustrative demo. These checks do not establish performance on the physical TV.

## Build checks

Version 0.1.8 adds the full-screen multi-camera overview. Browser checks used the illustrative demo:

- The Full screen control expanded the eight-camera featured layout, hiding the dashboard header and margins. The desktop browser's native fullscreen request succeeded.
- Four-camera layout paging showed cameras 5–8 on page 2. Opening Garage and returning restored the full-screen grid, page 2, and focus on Garage. Exiting restored the dashboard on the same page.
- Layout selection remained accessible in full screen; the stacked two-camera layout applied successfully, and Escape restored the normal dashboard without an exit-app dialog.
- A temporary test frame explicitly denied browser fullscreen. The app still expanded the grid within the viewport, hid its controls and focus outline after inactivity, and revealed controls and moved camera focus on an arrow key.
- The overview and full-screen grid were visually inspected with the eight-camera featured and four-camera equal layouts. No errors were reported in the main demo tab. The temporary fullscreen-denial harness was removed before packaging.

Version 0.1.8 used snapshots in fullscreen. Version 0.1.9 replaces those with simultaneous live streams; the checks below cover that change.

Version 0.1.9 was checked in the in-app Chromium browser using a **25-channel simulator** and a continuously looped H.264/AAC FLV fixture:

- All **24 online cameras decoded at 640 × 360 concurrently** in the 25-tile fullscreen grid. Two observations showed advancing playback time for every online tile; all were muted and reported live. The remaining tile retained its offline status. Playback continued across the fixture's ten-second loop boundary.
- The simulator counted 24 separate substream connections and no continuing snapshot requests during fullscreen playback.
- Changing to four tiles left four active streams and did not open replacements for those retained cameras.
- Paging to cameras 5–8 closed the previous page's connections and opened three streams, excluding offline camera 7.
- Expanding camera 5 left exactly one active video connection. Returning restored fullscreen page 2 and camera 5's focus.
- Exiting fullscreen returned the simulator's active stream count to **zero**. Video sources were removed, every tile video was paused/hidden, and snapshot loading resumed.
- A temporary iframe denied native browser fullscreen to exercise the app's viewport-filling fallback. It was removed before packaging. The browser reported an automation MutationObserver error during initial page setup; no tile ended in an error state during the playback check.

These are decoded synthetic test streams, not recordings or footage from the user's cameras. Physical S90C decoding and NVR concurrency limits remain unverified.

Version 0.1.4 adds the local bridge for real-NVR browser use. The connection screen was opened with `?connect=1`, with the old simulator address cleared and automatic demo entry disabled. No real NVR login or video has been verified yet: the user must supply the recorder address and credentials in that screen.

Version 0.1.5 preserves bridge diagnostics through the API client and distinguishes preview-session failures from NVR authentication failures. Initial connection/header waits are bounded to 6.5 seconds so the server can return a useful diagnostic before the client's own timeout. The existing local server responded with HTTP 200 during troubleshooting. The user's NVR address was not available, so the cause of their particular 502 and real-camera connectivity remain unverified. Browser inspection was blocked on the existing browser error page; no new visual check is claimed for this update.

Version 0.1.6 follows up on the user-reported redirect error. Its destination is now displayed when it points to a Reolink API path on the same recorder, with all query parameters and credentials removed. The embedded preview became accessible but contained a blank NVR address and no error, so the user's actual redirect destination remains unknown. No real NVR login or camera footage was verified in this update. Browser QA screenshots remain local and are excluded from the source archive.

Version 0.1.7 was checked against the user's actual recorder without credentials. Its HTTP API returned a 302 to the same device's HTTPS home page. HTTPS failed normal validation with a self-signed-certificate error. The updated browser's **Check address** flow successfully switched to HTTPS, inspected the real recorder's certificate, and displayed its fingerprint and validity on the approval panel. The certificate was not approved by the agent; no recorder password was requested or transmitted, and no real login or video playback is claimed. The preview approval uses an origin-specific CA and leaf-fingerprint check for subsequent requests, while retaining TLS chain and expiry checks. Trust is kept in memory only and never added to the OS trust store.

`npm run package` copies the complete app to `dist/` and creates a widget archive with `config.xml` at the ZIP root. The player and its license are bundled; no CDN or npm installation is needed for the app to run. The source archive includes source, scripts, tests, documentation, and the unsigned widget.

## Not yet verified

- Samsung certificate creation/signing and installation on the physical S90C.
- The S90C's MSE decoder, on-screen keyboard, remote key delivery, app suspension, and firmware-specific network behavior.
- The number of simultaneous live streams sustained by the physical TV and the user's recorder. Direct-TV HTTP connections and hardware decoder limits can require smaller layouts; browser results do not establish TV capacity.
- Actual connectivity to the user's RLN16-410 (N6MB01, firmware v3.0.0.201_22082208, identified from the supplied screenshot), including API permissions, camera codecs, RTMP/HTTP settings, and FLV authentication behavior.
- Audio output on the TV; browser testing verified decoding, with playback muted by default.
- Extended unattended use and recovery from actual TV sleep/network outages.

No private camera footage, NVR credentials, or signing keys are included in the source or widget.

## Reproduce the simulated-NVR check

Install FFmpeg, then create disposable media in `.cache/`:

```sh
mkdir -p .cache
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=640x360:rate=15' \
  -f lavfi -i 'sine=frequency=440:sample_rate=44100' -t 10 \
  -c:v libx264 -preset ultrafast -tune zerolatency -g 15 -pix_fmt yuv420p \
  -c:a aac -b:a 64k -f flv .cache/test.flv -y
ffmpeg -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=640x360:rate=1' \
  -frames:v 1 .cache/snapshot.jpg -y
```

In separate terminals run `npm run dev` and `node scripts/mock-nvr.mjs`. Open http://127.0.0.1:4173 and connect to `http://127.0.0.1:4174` with username `viewer` and password `demo`. Those are disposable simulator credentials. The simulator intentionally stops sending video after ten seconds while leaving the socket open, so the player eventually exercises its stalled-stream recovery path. It is bound to localhost and is not included in the TV widget.

To exercise continuous live playback in the largest grid, start the simulator with `MOCK_CHANNEL_COUNT=25 MOCK_LOOP_VIDEO=1 node scripts/mock-nvr.mjs`, connect, and select **Full screen**. Loop mode rebases FLV timestamps and paces packets continuously. The simulator accepts 1–64 channels; the default remains eight. Without loop mode it retains the deliberate stalled-stream behavior described above.
