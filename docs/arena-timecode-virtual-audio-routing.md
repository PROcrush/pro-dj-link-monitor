# Arena Timecode Virtual Audio Routing

## Decision

Arena SMPTE sync must be routed as audio. The reliable product route is:

`PRO DJ LINK deck time -> LTC audio generator -> virtual audio output endpoint -> virtual audio input endpoint -> Arena Audio Input Device -> SMPTE Input 1/2`.

This replaces the previous Bridge/TCNet/Pioneer-native attempts for this feature. The app should keep the Virtual CDJ listener for deck state, then output LTC through a system-visible virtual audio cable.

This is a virtual sound-card route, not a virtual network-card route. PRO DJ LINK
state still comes from the LAN / Virtual CDJ side, but Arena's SMPTE follow mode
must receive audio LTC through an input device.

## macOS

Preferred route:

- Use a CoreAudio HAL virtual audio device.
- BlackHole is the strongest existing candidate: it is a modern macOS loopback driver, supports Intel and Apple Silicon, supports 48 kHz, and does not require kernel extensions.
- Do not silently bundle unofficial BlackHole binaries under our own brand. Its source is GPL-3.0 and official binaries/branding have separate restrictions. Either use an installer handoff/licensed distribution, or build our own HAL driver.

Practical app behavior:

- Detect BlackHole, Loopback, Soundflower, VB-CABLE, and other bidirectional virtual audio devices.
- Warn when Arena has no Audio Input Device or no SMPTE channel selected.
- Prefer BlackHole 2ch when present.
- Do not treat `EMEET Virtual Audio` as Arena-ready. On this test machine it exposed 2 in / 2 out and worked as a macOS default output target, but Arena 7.16 hung during startup when configured to use it as the audio input.
- Wrapping `EMEET Virtual Audio` in a CoreAudio Aggregate Device (`PRO DJ LINK LTC Aggregate`) did not solve the Arena issue; Arena still launched without creating a window. The aggregate test device was destroyed and Arena config was rolled back.
- A physical smoke test using Mac mini speaker output into the current microphone did not lock Arena SMPTE either. The clip was successfully switched to `SMPTE 1` over the Arena REST API, but its transport position stayed at `0` while a 25fps LTC WAV played. This confirms the remaining requirement is a reliable line-level virtual audio input, not more REST/clip control work.
- The lab has gated scripts for a local BlackHole install and rollback:
  - `labs/ltc-audio-timecode/install-blackhole-hal.sh --dry-run`
  - `labs/ltc-audio-timecode/uninstall-blackhole-hal.sh --dry-run`
  - `labs/ltc-audio-timecode/run-arena-ltc-smoke.sh --dry-run`
  - Actual install requires an explicit confirmation flag and administrator rights because it writes a persistent HAL driver and restarts CoreAudio.

## Windows

Implemented P1 route:

- `src/windows-audio-helper` is a native C++ WASAPI shared/event-driven helper.
- The app enumerates the real MMDevice render endpoint ID and sends continuous
  `start / sync / hold / shutdown` commands over NDJSON.
- Automatic mode writes directly to the selected virtual playback endpoint and
  never changes the Windows default speaker.
- Helper startup and endpoint-open acknowledgement are part of bridge startup;
  failure is closed and does not silently fall back to the system speaker.
- The old PowerShell `SoundPlayer` route remains available only after the user
  explicitly confirms manual routing.
- Windows packaging builds the matching x64 or ARM64 helper first and unpacks
  the executable outside `app.asar`.

Preferred short-term route:

- Detect VB-CABLE / Voicemeeter / Virtual Audio Cable endpoint pairs.
- Generate LTC to the playback endpoint (`CABLE Input` on VB-CABLE).
- Configure Arena to listen to the paired recording endpoint (`CABLE Output` on VB-CABLE).
- If the native helper is unavailable, the manual fallback runbook is: set the
  default playback device to `CABLE Input`, explicitly enable manual routing in
  the app, then set Arena's Audio Input Device to `CABLE Output`.

Preferred long-term route:

- Build a dedicated signed WDM/WaveRT virtual audio driver based on Microsoft's SysVAD sample.
- Name endpoints clearly, for example:
  - `PRO DJ LINK LTC Input` as the playback endpoint the app writes to.
  - `PRO DJ LINK LTC Output` as the recording endpoint Arena listens to.

Important Windows constraint:

- A production Windows virtual audio driver must be signed. Windows 10 1607+ requires Microsoft signing for new kernel-mode drivers, and production submission requires the Windows Hardware Dev Center flow.
- Test-signed drivers are only for lab builds and should not be shipped to users as the default path.

## Why VB-CABLE Is Useful But Not Ownership

VB-CABLE supports Windows and macOS and exposes the exact playback/recording pair needed for Arena SMPTE. It is donationware/proprietary, so the app can detect it and guide installation, but redistribution/bundling requires checking VB-Audio licensing.

## Implementation Notes

- `src/prolink/audioDevices.cjs` detects macOS CoreAudio devices with `system_profiler`.
- On Windows it detects paired audio endpoints from PowerShell/WMI and groups `CABLE Input` + `CABLE Output` as one route.
- Windows detection keeps the playback endpoint and recording endpoint names so the UI can show `software output -> Arena input` clearly.
- The app should not change global system defaults by default. Prefer writing LTC directly to the selected virtual output endpoint when the playback layer supports it.

## Sources

- Resolume SMPTE docs: https://resolume.com/support/en/smpte
- Resolume Preferences / Audio Input docs: https://resolume.com/support/en/preferences
- BlackHole GitHub: https://github.com/ExistentialAudio/BlackHole
- Microsoft SysVAD sample: https://github.com/microsoft/Windows-driver-samples/tree/main/audio/sysvad
- Microsoft driver signing policy: https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-
- VB-CABLE official page: https://vb-audio.com/Cable/
