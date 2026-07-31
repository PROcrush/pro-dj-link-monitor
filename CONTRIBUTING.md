# Contributing

Thanks for helping improve PRO DJ LINK Monitor.

## Development setup

Use Node.js 22.12 or newer:

```sh
npm ci
npm test
npm start
```

Keep changes focused and add regression tests for protocol parsing, timing,
output routing or lifecycle behavior.

## Safety invariants

- Do not add CDJ load, play, pause, master, sync or track-control commands.
- A missing or stale timing anchor must remain unavailable; never invent
  `00:00:00:00`.
- Generated LTC delay compensation must not modify canonical deck timing.
- Network-facing services must be loopback-only by default. LAN exposure must
  remain an explicit user choice.
- Do not commit live packet captures, logs, track metadata, device identifiers,
  local paths, build products or third-party binaries.

## Protocol fixtures

Use synthetic fixtures where possible. If a real capture is necessary, remove
timestamps, IP/MAC addresses, device-unique values and track metadata before
placing it under version control. Explain how the fixture was sanitized.

## Windows helper

The WASAPI helper requires Windows 10/11, Visual Studio 2022 Build Tools with
Desktop development with C++, and CMake. See
`src/windows-audio-helper/README.md`.

## Licensing contributions

By submitting a contribution, you certify that you have the right to provide
it under the license that applies to the modified file. New original files use
MIT unless clearly documented otherwise. Changes to
`src/prolink/virtualCdj.cjs` remain under EPL-2.0.

Use a Developer Certificate of Origin sign-off in commits:

```text
Signed-off-by: Your Name <you@example.com>
```

## Pull request checklist

- Tests pass with `npm test`.
- New behavior is documented.
- No secrets, personal data, captures or generated binaries are included.
- Platform-specific behavior states what was and was not tested on real
  hardware.
