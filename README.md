# PRO DJ LINK Monitor — Unofficial

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/PROcrush/pro-dj-link-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/PROcrush/pro-dj-link-monitor/actions/workflows/ci.yml)

An open-source macOS and Windows monitor for DJ playback state, waveforms and
timecode-oriented VJ workflows on PRO DJ LINK networks.

> This is an independent, unofficial interoperability project. It is not
> affiliated with, endorsed by, sponsored by, licensed by or certified by
> AlphaTheta Corporation, Pioneer Corporation/Pioneer DJ, TC Supply or
> Resolume B.V.

The project is source-first. Unsigned preview binaries are available from the
[v1.4.4 prerelease](https://github.com/PROcrush/pro-dj-link-monitor/releases/tag/v1.4.4);
signed and notarized binaries have not been released yet.

## Downloads

| Platform | Package | Architecture |
| --- | --- | --- |
| macOS | DMG or ZIP | Apple Silicon (`arm64`) |
| Windows | NSIS installer or portable EXE | x64 |

The v1.4.4 files are an **unsigned preview release**. macOS Gatekeeper and
Windows SmartScreen may show an unidentified-publisher warning. Verify the
download against the release's `SHA256SUMS.txt` before opening it. Intel macOS
and Windows ARM64 packages are not part of this release.

> **Compatibility notice:** CDJ-3000X and CDJ-1500X have not been tested with
> this project, so compatibility is currently unknown. Because the monitor's
> compatibility layer announces a Virtual CDJ identity on the network, we
> recommend using no more than three physical CDJs while the monitor is active.

## What it does

- Monitors PRO DJ LINK device announcements, beat/status packets and DBServer
  metadata visible on the selected local network.
- Displays up to four decks with title, artist, BPM, playback state, timing,
  artwork, waveform, beat grid and cue information when available.
- Publishes canonical deck state through local WebSocket and optional OSC.
- Provides a trusted-LAN web viewer when the user explicitly enables it.
- Supports Resolume-oriented BPM/downbeat output and experimental TCNet
  capture/research workflows.
- Generates continuous LTC audio. Windows uses a native WASAPI helper for a
  selected render endpoint such as VB-CABLE; macOS can use an installed
  virtual-audio device.

Missing or stale timing remains unavailable. The application never converts a
missing timing source into a false `00:00:00:00` value.

## Safety model

The monitor does **not** send CDJ load, play, pause, master, sync or track
control commands.

The application is not completely silent on the network:

- Its Virtual CDJ compatibility probe announces a local presence so compatible
  players can return metadata and waveform data.
- Optional OSC, Arena, TCNet and LTC outputs transmit only when enabled.
- Raw TCNet capture records observed packets for diagnostics.

Use it on an isolated, trusted DJ/show-control network and test changes away
from a live production first.

## Quick start

1. Connect the computer and CDJ/DJM equipment to the same wired LAN switch.
2. Install dependencies and start the application:

   ```sh
   npm ci
   npm start
   ```

3. Select the wired IPv4 interface connected to the DJ equipment, then start
   monitoring.
4. On first launch, allow Local Network access on macOS. On Windows, allow the
   firewall prompt only for trusted private networks.
5. Web/WS access is local-only by default. Enable trusted-LAN access in Advanced
   settings only when another trusted device needs the viewer.

Connected deck state, BPM and live transport information confirm basic
monitoring. Titles, waveforms and cues additionally require a compatible
player, the correct Virtual CDJ interface and accessible DBServer data.

## Requirements

- Node.js 22.12 or newer for development.
- macOS or Windows. Linux is not currently supported.
- A wired IPv4 interface on the same trusted LAN as the DJ equipment.
- Optional Resolume Arena, BlackHole or VB-CABLE installations are provided
  and licensed separately by their vendors.

## Device compatibility and deck-count guidance

- **CDJ-3000X:** not tested; compatibility is unknown.
- **CDJ-1500X:** not tested; compatibility is unknown.
- Player firmware, mixer/network topology and device-number allocation can all
  affect interoperability. Test the exact show setup away from production.

The monitor's Virtual CDJ compatibility layer announces a logical player
identity so compatible equipment can return metadata and waveform data. For
the current preview release, the operational recommendation is **no more than
three physical CDJs while the monitor is active**. This is stability guidance,
not a certified protocol limit.

## Develop from source

```sh
npm ci
npm test
npm start
```

The test suite is fixture-driven and does not require physical DJ hardware.
Native endpoint routing and actual LTC lock still require platform and hardware
smoke tests.

## Network surfaces

| Surface | Default | Bind/destination | Notes |
| --- | --- | --- | --- |
| PRO DJ LINK UDP | listening while monitor runs | selected local interface | Ports 50000, 50001, 50002 and 50004 |
| TCNet UDP capture | listening while monitor runs | local interfaces | Ports 60000, 60001, 60002, 65023 and 65024 |
| WebSocket | enabled | `127.0.0.1:7071` | Local JSON state output |
| Web Console | enabled | `127.0.0.1:7072` | LAN binding requires explicit trusted-LAN opt-in |
| OSC | disabled | `127.0.0.1:9000` | User-configurable destination |
| Arena Web API | disabled | `127.0.0.1:8080` | BPM/downbeat fallback; no continuous clip scrubbing by default |
| Audio LTC | disabled | selected audio endpoint | Virtual/physical routing must be explicitly configured |

The trusted-LAN Web Console does not provide account authentication or TLS.
Never forward ports 7071/7072 to the public internet or use them on an
untrusted Wi-Fi/VLAN. See [SECURITY.md](SECURITY.md).

## Timing and outputs

Deck timing is computed once and shared by the desktop UI, LAN viewer, OSC,
Arena and LTC outputs. Absolute-position packets are preferred when fresh;
beat-grid timing can provide a fallback. Paused decks hold their last valid
anchor instead of continuing to drift.

Useful OSC fields include:

- `/vj/deck/{deck}/timingValid`
- `/vj/deck/{deck}/timecode`
- `/vj/deck/{deck}/timecode/frame`
- `/vj/arena/sourceDeck`
- `/vj/arena/timingValid`
- `/vj/arena/timecode`
- `/vj/arena/elapsed`
- `/vj/arena/progress`

`LTC delay compensation` applies only to generated LTC audio and never shifts
canonical deck, OSC or TCNet time.

## Build applications

macOS Apple Silicon:

```sh
npm run package:mac
```

macOS Intel:

```sh
npm run package:mac:x64
```

Public macOS distribution requires Developer ID signing and notarization. The
macOS LTC helper is compiled with `/usr/bin/swift`, so Xcode Command Line Tools
are required for that development path.

Windows x64 builds must run in a native Windows 10/11 environment with Visual
Studio 2022 Build Tools (Desktop development with C++) and CMake:

```bat
npm run package:win
```

The prepackage step builds the matching WASAPI helper. Windows ARM64 scripts
exist but remain experimental until validated on real ARM64 hardware. See
[`src/windows-audio-helper/README.md`](src/windows-audio-helper/README.md).

The NSIS installer/portable outer stub may be reported as 32-bit even though
the packaged Electron application and helper are x86-64.

## Repository layout

```text
src/main.cjs                    Electron main process
src/renderer/                   Desktop UI
src/prolink/                    Protocol, timing and output modules
src/windows-audio-helper/       Native WASAPI LTC helper source
tests/                          Main regression suite
labs/timecode-consistency/      Isolated timing/capture experiments
labs/ltc-audio-timecode/        LTC rendering and routing experiments
docs/                           Publish-safe architecture/research notes
```

Generated packages, native binaries, WAV files and live packet captures are
intentionally excluded from Git. Clone optional BlackHole source separately
from its official repository when running the macOS driver lab.

## Capture and diagnostic privacy

TCNet and PRO DJ LINK captures may contain timestamps, private IP addresses,
device models and track metadata. Do not attach a live capture to a public
issue. Create a small synthetic fixture or sanitize every identifying field.

Automatic waveform failure logs are reduced before being persisted to disk.
An explicit user export can contain more detail and must be reviewed before
sharing.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a change. The project
keeps a strict no-CDJ-control safety boundary and requires tests for protocol,
timing and output lifecycle changes.

## Acknowledgements

Protocol interoperability work builds on public research by the Deep Symmetry
community and related open-source projects. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for source, license and
attribution details.

## License

Original project code is available under the MIT License. The separately
identified `src/prolink/virtualCdj.cjs` file is distributed under EPL-2.0
because its startup templates and logic are adapted from Deep Symmetry's
beat-link project. See [LICENSE](LICENSE),
[LICENSES/EPL-2.0.txt](LICENSES/EPL-2.0.txt) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

All product names and trademarks belong to their respective owners.
