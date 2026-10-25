# Validation — 22 October 2026

Later changes and checks are appended below. The **Automatic local certificate acceptance** section supersedes the historical certificate-review behavior recorded here.

## Automated checks

`npm test` runs Node's built-in test runner. Current tests cover:

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
- Address checks automatically upgrading HTTP to HTTPS and never sending a password.
- Local HTTPS login, snapshots and FLV bytes over real TLS handshakes with self-signed, changed and expired certificates, without approval.
- Automatic acceptance scoped to local NVR requests, with ordinary HTTPS verification still rejecting untrusted certificates.
- Public destinations, foreign origins, missing keys and non-Reolink paths rejected before connecting.
- Live grid reconciliation for up to 25 cameras, excluding offline/sleeping/demo tiles, retaining unchanged players and disposing removed ones.
- Independent per-camera errors, retrying only failed feeds, and ignoring delayed callbacks after disposal.
- Suppression of late stream URLs after leaving the grid, audio-free grid playback, bounded old video buffers, and event-listener cleanup.
- Ignoring errors from obsolete decoders after a reconnect.
- Twenty-five concurrent preview WebSocket streams delivering exact video bytes while API requests remain responsive.
- WebSocket origin/key enforcement, existing target/redirect/header protections, and upstream cancellation before or after headers arrive.
- Session-scoped reuse of proven stream authentication, isolation between clients, explicit mode overrides, and renegotiation of a remembered method.
- Keeping established feeds on their working authentication method after interruption, and immediate initial authentication fallback without reconnect backoff.
- Racing a silent initial stream sign-in after one second, retaining the original attempt until one returns a valid FLV header, preserving all received bytes, and cancelling the loser.
- Fragmented headers, HTTP/non-video rejection, bounded startup deadlines, late response cleanup, cancellation before/during/after selection, explicit sign-in overrides, and decoder reuse during transport selection.

The original 66 tests passed with the host Node executable during earlier validation. The network tests require loopback listeners, which the command sandbox does not permit. HTTPS tests use disposable certificates and a fixture key stored under `tests/fixtures`, never a recorder's certificate or credentials. Test fixtures were not shown as real camera footage. Current checks and their environment limitations are recorded below.

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

The initial 0.1.10 implementation kept overview feeds live to remove the fullscreen cold start. The historical checks below describe that implementation; the snapshot correction following them supersedes its overview behavior. Network loading still starts without waiting for the media source to open; the bundled player's pending-segment queue handles that ordering.

Browser checks used the continuously looped **25-channel simulator**, configured to reject token stream authentication:

- The four-camera overview recovered through credential authentication and played all four feeds. Enlarging the layout started the other 20 online feeds directly with the proven method: token attempts stayed at four, credential attempts reached 24, and all 24 feeds played.
- Before and after fullscreen entry, all 24 video elements retained their media-source URLs, remained live, and had advancing playback times. Exiting and entering again preserved those same sources and streams. The recorder still counted only 24 opened streams, establishing **zero reconnects for the fullscreen transitions**.
- Offline camera 7 retained its status and no stream. No snapshot requests competed with live startup.
- New streams still needed initial video data and decoding time; these checks establish continuity for fullscreen transitions, not instant first frames on a newly opened camera or performance on the user's recorder.

The overview has since been restored to snapshots only, refreshing every five seconds by default. The later setup simplification removes the interval control while preserving saved preferences. Fullscreen entry starts grid streams; exit stops them and resumes snapshots. The single-camera viewer still plays live video.

Validation of the snapshot correction:

- All 53 tests that do not open local network listeners passed, and `npm run build` and `git diff --check` passed. The 13 network integration tests could not run because the execution sandbox rejects loopback listeners with `listen EPERM`.
- A temporary in-memory application harness used the actual app code, fullscreen controller, live-grid controller, and snapshot poller with fake DOM/media boundaries. It verified zero live players on the overview, fullscreen live startup, stream disposal and snapshot resumption on exit, ignored late live events, snapshot-only overview resumption, and stream disposal when leaving the grid.
- No new browser or physical-TV check was performed for this correction.

The live-startup follow-up adds transport selection before the existing decoder. It races a silent sign-in after one second, validates the FLV header before selecting a stream, cancels the losing request, and retains the original request while the alternate starts. It also keeps grid videos renderable during connection and lowers the live catch-up threshold from three seconds to 1.5 seconds with the existing half-second buffer retained.

An isolated in-app Chromium page exercised the actual baseline/current player, custom loader, and bundled decoder against synthetic FLV bytes paced in real time. Ten cameras were opened concurrently. These measurements isolate startup logic; they do not measure the user's NVR, Firefox, the local WebSocket bridge, or the physical TV.

| Scenario | Before: all cameras showing frames / playing | After: all cameras showing frames / playing |
| --- | --- | --- |
| Normal stream | 156 ms / 378 ms | 135 ms / 375 ms |
| Token connection returns no video; credentials work | 15,146 ms / 15,382 ms | 1,140 ms / 1,379 ms |
| First keyframe arrives after a two-second gap | Not compared | 2,141 ms / 2,375 ms |

Normal-stream differences are within browser timing variation; the significant improvement is recovery from a silent initial sign-in. A valid stream waiting for its next keyframe remains connected. The temporary benchmark page and baseline player copy were removed before building.

All 66 tests that do not require network listeners passed, including 13 new startup/player tests. The other 13 tests were blocked by the sandbox's `listen EPERM` restriction. The production build and whitespace/syntax checks passed.

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

## Simplified setup and HTTPS default

Setup now presents a centered form with only NVR IP address, username, password, and Connect. Address checks run automatically on connection, and certificate review appears only when required. Existing saved preferences are preserved; Forget saved connection remains available for an existing connection. Bare addresses default to HTTPS, while explicit HTTP addresses remain supported. HTTPS addresses are displayed without the protocol prefix.

- All 20 API, preview-connection, and transport tests passed, including HTTPS defaults, explicit HTTP, custom ports, and IPv6. The production build and syntax/whitespace checks passed.
- A temporary DOM harness executed the actual application modules with simulated API responses. It checked the three-field form, rejected and successful logins, reopening settings, password visibility reset, forgetting data, preservation of existing preferences, and the certificate approval flow before any login was sent.
- A visual browser check could not run because the execution sandbox denied Chromium's process startup. No real NVR login or TV validation was performed for this change.
- LAN discovery has since been implemented as described below.

## LAN discovery: desktop and standalone TV

Setup remains three fields. An empty address starts an ONVIF search; one identified Reolink NVR fills its IP, multiple recorders require selection, and unknown Reolink devices are available for manual selection. Existing addresses and user edits are preserved. Discovery assumes HTTPS on port 443 rather than using the advertised ONVIF service port, sends no credentials and never approves TLS certificates.

The preview server probes private IPv4 LAN interfaces with UDP multicast (three probes over 3.5 seconds). Its endpoint requires the preview session key and origin checks, accepts no targets/body/credentials, allows one active scan, and cancels when the requesting connection closes. Replies must relate to the current probe, identify Reolink, and advertise an IP matching the UDP sender. Duplicate, unrelated, public-address and malformed replies are ignored.

The installed TV has a separate worker transport backed by `native/discovery.c` and Samsung's Emscripten Tizen Sockets Extension. It requires no preview key, Mac or server. The worker polls nonblocking UDP sockets with bounded work per tick, closes on completion/error/cancellation, and has a parent-side timeout. Setup cancels discovery before connecting, leaving setup, showing a modal, hiding or closing the app.

Validation completed:

- **25 new discovery tests passed**: protocol parsing/filtering, multi-interface multicast, retries, duplicate handling, endpoint protection, timeout/cancellation cleanup, TV socket-driver behavior, TV operation without desktop requests, selection, preservation of edits and stale-result rejection. Sockets and worker events in these tests are simulated; no LAN discovery is claimed from them.
- **91 tests passed** across discovery and existing API/player/setup/transport suites. The 13 existing network integration tests were not rerun because this execution sandbox had already rejected their loopback listeners with `listen EPERM`.
- A temporary jsdom/VM harness ran the actual app modules in desktop and simulated TV contexts. It checked three form inputs, automatic IP fill, no login during discovery, preservation of typed/saved custom-port addresses, TV worker creation without any desktop request, remote OK selecting a discovered recorder, page-hide cancellation and rejection of late results. This is a DOM behavior check, not a visual or physical-TV test.
- `clang -Wall -Wextra -Werror -fsyntax-only native/discovery.c` passed using the host POSIX headers. This does not validate Samsung's headers or socket implementation.
- `npm run build` passed for browser preview. `npm run package` correctly refused to produce a new TV widget without the native discovery runtime. `npm run doctor` reports the missing compiler/module and Tizen CLI. Generated runtime files, source hashes and the SDK license are required before packaging/signing.

Outstanding release checks: **Samsung Emscripten 1.39.4.7 is not installed, and the command environment cannot resolve the SDK download host. The native runtime has not been compiled. No new installable TV artifact was produced.** Follow the compiler setup in INSTALL.md, compile the module, then sign/install and validate multicast discovery, ONVIF scope/model identification, cancellation, and remote navigation on the actual S90C/NVR. Real LAN packets, SDK compilation, WASM/CSP behavior and hardware playback were not validated here. A visual browser check also remains unavailable due to the previously recorded browser-process sandbox restriction.

## Automatic local certificate acceptance

At the user's request, the desktop preview now always accepts the local NVR's HTTPS certificate. This replaces the earlier manual review and fingerprint approval flow entirely, including for changed or expired certificates. The approval panel, certificate endpoints and in-memory trust manager have been removed. TLS remains encrypted; certificate identity and validity are not verified for these local Reolink requests. The relaxation is set on each validated local HTTPS request, with the existing origin/key, destination, DNS and redirect restrictions retained. The OS trust store and global Node TLS configuration are unchanged. The installed TV continues using its platform's HTTPS handling.

- **96 runnable tests passed**, including four certificate regression tests using real TLS handshakes over in-memory duplex streams. They verify login, JPEG and FLV responses with self-signed certificates; acceptance after replacement or expiry; ordinary HTTPS still rejecting untrusted/expired certificates; and rejection of public destinations, foreign origins and missing preview keys before connecting.
- The remaining 11 existing HTTP/WebSocket listener integration tests were not rerun because this execution environment previously rejected their loopback listeners. The TLS tests now need no listener, and do not contact any real recorder.
- A temporary DOM harness executed the actual app modules and verified that one Connect submission reaches the camera grid with simulated API responses, without certificate requests, an approval panel or a second click. It also checked that the removed header clock and Forget saved connection button remain absent.
- `npm run build`, modified JavaScript syntax checks and `git diff --check` passed. The user must stop the old preview server, run `npm run dev` again and reload the page to activate the new server behavior. An older running preview receives explicit restart guidance rather than reopening certificate review.

## Automatic connection restoration

Successful connections now save their credentials automatically in both browser and TV app storage. Refreshes and relaunches reconnect with those credentials, including launches from existing `?connect=1` bookmarks. Successful sign-in clears setup/demo launch flags while preserving other URL parameters and fragments. Failed sign-ins do not replace the last saved connection. This supersedes the earlier opt-in password persistence behavior described above.

- All 21 API, storage, layout, and preview connection tests passed.
- A temporary jsdom/VM harness ran the actual app modules in browser and simulated TV contexts. It verified migration from `remember: false` after a successful sign-in, automatic reconnect after refresh and relaunch, reconnection from an old setup bookmark, preserved layout/favorites, session cleanup retaining saved credentials, snapshot-only overview restoration, and rejected logins leaving saved data unchanged without retry loops.
- The same harness checked unavailable browser history and storage. A history failure does not interrupt login; a storage failure leaves the active connection working and displays the existing save-error message.
- These checks use simulated NVR responses and TV platform boundaries. Physical-TV storage persistence and relaunch have not been verified on hardware.

## Native Reolink discovery

Search now sends native Reolink LAN broadcasts alongside ONVIF. The previous implementation depended on ONVIF being enabled. Desktop scanning includes each LAN interface's subnet broadcast address and the limited broadcast address; the TV source uses its own native socket. Results merge by IP, and repeated searches release and reopen the fixed native reply port.

All 35 discovery tests passed, including native-only replies, mixed-protocol identity, repeated searches, partial transport failures, cancellation, occupied reply ports, blocked access, and omission of credential fields. The full-app DOM and connection-restoration checks passed. A host-compiled C harness with mocked socket calls verified exact probe bytes and ports, receive fairness, partial initialization and repeated cleanup; C syntax checks and the browser build also passed.

The live LAN scan could not open discovery sockets in this environment. Native reply fixtures are synthetic, not captures from the user's NVR. The Samsung module is still uncompiled and needs a hardware test. See [DISCOVERY.md](DISCOVERY.md) for protocol sources, validation limits, and restart/build instructions.

## Native reply parsing correction

Live desktop testing found that the recorder answered the native probe, but the parser discarded its response: the reply did not echo the request magic, and the model field was empty. Its 388-byte device-info record had a zero prefix and `NVR` in the type field at offset 132. The parser now uses bounded, validated type/model fields and preserves generic NVR identity when duplicate replies are merged. It continues to exclude device credentials and use the UDP sender as the address.

- The corrected desktop scan found the owner's actual recorder. No real packet, device identifier, or network address is included in these fixtures or this report.
- All 38 discovery tests passed. The new regression failed against the old parser before the fix; coverage also checks malformed identity fields, preserved ONVIF metadata, automatic NVR selection, and omission of access-key fields.
- The preview process had also started before the latest discovery code. `npm run dev` now watches server modules so future changes restart the process; browsers still need a reload for the new session key.
- The parser is shared with the TV worker, but this live validation was on the desktop. Physical-TV discovery and the Samsung module build remain separate checks.

## First-time setup flow — 25 October 2026

The Blue connection screen now separates Search, Select, and Sign in. A single discovered recorder remains an explicit choice. Retry and manual address entry are available when discovery is empty, fails, or is unsupported. Back returns to the previous step. Changing recorders clears the prior password; successful saved connections still reconnect automatically.

- All 121 automated tests passed. Discovery UI coverage includes explicit single-recorder selection, multiple devices, stale-result cancellation, retry, unsupported hosts, and preserving completed results while navigating away and back.
- Browser checks using synthetic discovery/API responses verified the animated search screen, a five-recorder list with arrow-key scrolling, single-recorder selection, retry after empty results, search errors, and the static-host manual fallback.
- Manual address validation rejected URL paths and accepted a custom HTTPS port. Login Back preserved that address. Switching to a different recorder cleared the entered password.
- A rejected login returned focus to Password; retrying with synthetic valid credentials opened the camera grid. Reload reconnected automatically, and Settings → Change and Back to cameras worked without replacing the saved connection. Fixture request records showed no login request during search or selection.
- JavaScript syntax checks and the browser build passed. These setup-flow checks used the desktop browser; the updated widget has not been installed or tested on a physical TV.
