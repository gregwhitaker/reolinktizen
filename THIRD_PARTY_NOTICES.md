# Third-party software

The app bundles **mpegts.js 1.8.2** by xqq and contributors, licensed under Apache-2.0.
Source: https://github.com/xqq/mpegts.js
Distribution: https://registry.npmjs.org/mpegts.js/-/mpegts.js-1.8.2.tgz
Its original license is included at `app/vendor/mpegts.LICENSE` and in the TV package.
The downloaded npm tarball was verified against the registry's SHA-512 integrity value.
The distribution file is unmodified. No CDN is used at runtime.

The desktop preview bundles **ws 8.22.0** by Einar Otto Stangvik and contributors,
licensed under MIT. It is included only in the source/preview server, not the TV widget.
Source: https://github.com/websockets/ws
Distribution: https://registry.npmjs.org/ws/-/ws-8.22.0.tgz
Its original license is included at `scripts/vendor/ws/LICENSE`.
The unmodified npm distribution was verified against the registry's SHA-512 integrity:
`sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==`.

All camera illustrations in demo mode are generated locally by this project and clearly labeled.

Building TV discovery with **Samsung Emscripten SDK 1.39.4.7** generates JavaScript
and WebAssembly runtime files under `app/vendor/discovery/`. The build copies the
SDK's original `LICENSE` into that directory and packages it with the runtime.
Samsung's fork is required for Tizen native sockets; it is obtained separately
from https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/download.html.
The generated runtime is not present until `npm run build:discovery` succeeds.

Reolink and Samsung are trademarks of their respective owners. This is an independent project.
