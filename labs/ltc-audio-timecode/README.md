# LTC Audio Timecode Lab

This directory is an isolated research and smoke-test environment. Its scripts
can exercise system audio routing and are not part of the normal application
startup path.

It generates Linear Timecode / SMPTE LTC as a WAV file:

```bash
node labs/ltc-audio-timecode/render-ltc-wav.cjs \
  --fps 25 \
  --seconds 20 \
  --out labs/ltc-audio-timecode/out/ltc-25fps.wav
```

Run self-tests:

```bash
node --test labs/ltc-audio-timecode/*.test.cjs
```

Run the Arena smoke test:

```bash
node labs/ltc-audio-timecode/try-arena-ltc.cjs
```

If `Audio MIDI Setup` shows `BlackHole 2ch` but the current CLI environment
cannot enumerate CoreAudio devices, set the system output and Arena Audio Input
Device to `BlackHole 2ch`, then run:

```bash
node labs/ltc-audio-timecode/try-arena-ltc.cjs --manual-route --manual-route-name "BlackHole 2ch"
```

The desktop advanced page has the same fallback as a `手动` checkbox in the
`LTC Demo` row. Only use it after system output and Arena Audio Input Device
have both been set to `BlackHole 2ch`.

The smoke report reads Resolume's `config.xml` and reports
`arenaConfig.audioInputDeviceName`. In manual-route mode the preflight is only
complete when that value also points to `BlackHole 2ch`.

The intended live routing is:

```text
PRO DJ LINK canonical elapsedMs
-> realtime LTC audio generator
-> virtual audio playback endpoint, such as BlackHole 2ch or CABLE Input
-> paired virtual audio recording endpoint, such as BlackHole 2ch or CABLE Output
-> Arena SMPTE input
```

`EMEET Virtual Audio` is intentionally excluded from live Arena tests because
Arena 7.16 hung when configured to use it as the audio input on the current
test machine.

Windows route:

- Install a compatible loopback device such as VB-CABLE.
- Send the app's LTC playback to `CABLE Input (VB-Audio Virtual Cable)`.
- Set Arena's Audio Input Device to `CABLE Output (VB-Audio Virtual Cable)`.
- The smoke-test script detects this pair and reports both endpoint names.

## macOS Test Driver Install

A bidirectional CoreAudio loopback device is required before Arena can receive
SMPTE LTC. BlackHole is not bundled in this repository. Obtain it from the
official project and build it according to its upstream instructions; the lab
scripts expect an optional local checkout at `labs/BlackHole` with the built
driver at `labs/BlackHole/build/BlackHole.driver`.

The lab includes dry-run-first install scripts:

```bash
labs/ltc-audio-timecode/install-blackhole-hal.sh --dry-run
labs/ltc-audio-timecode/uninstall-blackhole-hal.sh --dry-run
```

Actual install is intentionally gated because it writes a system HAL driver to
`/Library/Audio/Plug-Ins/HAL` and restarts `coreaudiod`:

```bash
sudo labs/ltc-audio-timecode/install-blackhole-hal.sh --i-understand-this-installs-a-system-audio-driver
node labs/ltc-audio-timecode/try-arena-ltc.cjs
```

The one-shot smoke runner prints the full plan by default:

```bash
labs/ltc-audio-timecode/run-arena-ltc-smoke.sh --dry-run
```

After explicit system-driver authorization, run:

```bash
sudo labs/ltc-audio-timecode/run-arena-ltc-smoke.sh --install-test --rollback-on-fail
```

Rollback:

```bash
sudo labs/ltc-audio-timecode/uninstall-blackhole-hal.sh --i-understand-this-removes-a-system-audio-driver
```
