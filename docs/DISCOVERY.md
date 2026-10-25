# LAN discovery

Search runs two credential-free probes together for 3.5 seconds, retrying at 0, 700, and 1800 milliseconds:

| Transport | Destination | Replies |
| --- | --- | --- |
| Reolink native discovery | UDP 2000, subnet and limited broadcast | Local UDP 3000 |
| ONVIF WS-Discovery | UDP 3702, 239.255.255.250 | The requesting socket |

The native probe is four bytes: `aa aa 00 00`. Reolink's own [discovery explanation](https://community.reolink.com/topic/87/how-does-the-reolink-uid-actually-work) documents the probe and reply ports. Its [CLI maintainers describe the two discovery methods](https://github.com/reolink/reolink-cli/issues/36), including why ONVIF-only discovery misses devices with ONVIF disabled.

Native replies are device-info records, not echoes of the four-byte probe. The owner's recorder returned a 388-byte record with a zero prefix, an empty model, and `NVR` in the 32-byte device-type field at offset 132. The parser reads that bounded type field and the 32-byte `cMouduleType` model field at offset 196, documented by the CLI maintainers in that issue. It requires a recognized device type or model, uses only the private IPv4 UDP sender as the connection address, and recognizes an NVR even when its model is blank. Other recognized devices remain selectable. It never extracts UID, access-key, or other unrelated fields. The documented access-key field starts at offset 292 and is outside the parsed range. ONVIF can supply the friendly name; replies from both protocols merge into one result per IP without letting a generic label replace a real name.

The desktop preview opens separate sockets for each protocol on each eligible LAN interface. Directed broadcast addresses use the actual interface netmask. The TV worker opens two native sockets and polls them fairly without requiring a desktop server. Each search closes its sockets on completion, cancellation, or error. A failure of one transport does not discard results from the other.

Neither protocol discovers across isolated subnets/VLANs by itself. An occupied native reply port or blocked network access is reported instead of being presented as an ordinary empty search. Desktop discovery remains restricted to authenticated, same-origin preview requests with no client-supplied addresses or credentials. Advertisements do not establish trust or change recorder settings. HTTPS port 443 is assumed; the protocol's media/service ports are not substituted for the web/API port.

## First-time setup

Without saved credentials, launch shows a dedicated searching screen, then a selectable list with device names/models and IP addresses. A single result also requires explicit selection. Selecting a result opens the recorder’s username/password screen; discovery itself never signs in. Back returns to the existing list without an unnecessary scan. Manual entry is available during search, after an empty result or error, and on hosts without discovery support. Leaving search aborts it and ignores late replies.

Saved successful connections continue reconnecting automatically. Connection settings open the saved recorder’s login screen, with Change to select a different recorder. Changing the address clears the prior password; failed login attempts leave the saved connection unchanged.

## Validation limits

Native fixtures are synthetic and reproduce the observed zero-prefix, empty-model NVR format without storing real device identifiers or packets. Automated tests cover native-only discovery, mixed-protocol replies, repeat searches, cancellation, protocol/interface failures, address validation, port conflicts, and omission of credential fields. A host-compiled C harness mocks socket calls to check both destination/reply ports, exact probe bytes, receive fairness, partial failures, and repeated cleanup.

Live desktop discovery was verified against the owner's NVR after correcting the reply parser. All 38 discovery tests pass, including the regression for a record that the old parser discarded. The Samsung Emscripten module still needs the SDK build and physical-TV validation described in [INSTALL.md](INSTALL.md#build-the-tvs-discovery-module). Changes to the native source/build recipe invalidate any old module through the existing build manifest checks.

`npm run dev` now watches its server modules and restarts when desktop discovery changes. Reload the browser after a restart to receive the new preview session key. An already-running server from before this change needs one manual restart. Rebuild the discovery module and install an updated widget to apply the TV changes.
