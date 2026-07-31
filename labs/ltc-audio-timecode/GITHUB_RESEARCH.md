# GitHub LTC / SMPTE Timecode Research

Date: 2026-07-04

Goal: find reusable code paths for generating audio LTC that Resolume Arena can
lock to, while keeping the production application unchanged during the
experiment.

This document records the research state on the date above. It is useful as
design and licensing context, but it does not describe the current production
implementation. Check the application source and current tests for that.

## Shortlist

### x42/libltc

- URL: https://github.com/x42/libltc
- Language/license: C, LGPL-3.0
- Role: best correctness reference and likely production core.
- Why it matters:
  - Encodes and decodes LTC audio to/from SMPTE/EBU timecode.
  - Has mature sample-remainder handling across LTC bit periods.
  - Applies LTC rise-time shaping instead of only emitting a hard square wave.
  - Supports standard TV/fps modes through the library API.
- Integration note:
  - Prefer linking/bundling as a native helper or native addon if we need stable
    Arena lock.
  - Keep LGPL obligations in mind if distributing inside the app.

### x42/ltc-tools

- URL: https://github.com/x42/ltc-tools
- Language/license: C, GPL-2.0
- Role: reference CLI and live-output implementation around libltc.
- Useful files:
  - `ltcgen.c`: writes WAV LTC files using libltc.
  - `jltcgen.c`: real-time JACK LTC output with latency compensation.
  - `common_ltcgen.c`: fps parsing, drop-frame checks, and timecode setup.
- Integration note:
  - Do not copy GPL tool code into the app.
  - Use it as an implementation reference for our isolated lab and tests.

### patopesto/linear-timecode-js

- URL: https://github.com/patopesto/linear-timecode-js
- Language/license: JavaScript, MIT
- Role: best pure-JS reference for Electron-side experiments.
- Why it matters:
  - Implements LTC encoder and decoder.
  - Supports 24, 25, 29.97, and 30 fps.
  - Handles drop-frame, color-frame, polarity correction, user bits, volume, and
    rise/fall controls.
- Integration note:
  - Good candidate for lab validation and possibly app-side fallback.
  - Needs testing against Arena because the repo is small and less battle-tested
    than libltc.

### loupus/LtcWaveAudio

- URL: https://github.com/loupus/LtcWaveAudio
- Language/license: C, MIT
- Role: practical audio-streaming example using libltc.
- Why it matters:
  - Shows how to queue blocks of encoded LTC audio and stream them to an audio
    device.
  - Uses 48 kHz / 25 fps examples that match our Arena test path.
- Integration note:
  - Windows MME-specific audio layer is not directly useful on macOS.
  - The block queue model is useful for designing a macOS CoreAudio output.

### jeffmikels/timecode_tools

- URL: https://github.com/jeffmikels/timecode_tools
- Language/license: Python, MIT
- Role: readable educational generator and MTC/LTC reference.
- Why it matters:
  - Generates WAV LTC from timecode values.
  - Easy to compare against our pure-JS lab output.
- Integration note:
  - Useful for tests and conceptual cross-checking, not a production dependency.

### chrisspiegl/node-smpte-ltc

- URL: https://github.com/chrisspiegl/node-smpte-ltc
- Language/license: JavaScript, no explicit license found in repo metadata.
- Role: decoder-only prototype.
- Why it matters:
  - Shows one approach to extracting SMPTE LTC from clean WAV/PCM.
- Integration note:
  - Archived and explicitly prototype-level.
  - Useful only as a sanity-check reference, not as a dependency.

## Key Technical Takeaways

1. LTC output quality matters. A perfect square wave can pass simple self-tests
   but may be less reliable as a real audio input. libltc shapes transitions
   around the expected LTC rise time.
2. 48 kHz, 25 fps is a strong first target for Arena because it gives exactly
   1920 samples per LTC frame, making drift easier to reason about.
3. 30 fps and 29.97 fps need careful drop-frame/non-drop-frame handling. We
   should not guess this in the app UI.
4. The production design should have two layers:
   - a deterministic timecode model from PRO DJ LINK deck state;
   - an audio LTC generator verified against a decoder before Arena testing.
5. For distribution, libltc is acceptable only if we handle LGPL correctly. GPL
   code from ltc-tools should remain reference-only.

## Historical Next Step

At the time of this research, the recommended next step was to create a second
isolated lab implementation:

1. Build or vendor libltc as a local helper binary in `labs/ltc-audio-timecode`.
2. Generate the same 25 fps WAV from both our JS generator and libltc.
3. Decode both outputs and compare:
   - frame sequence;
   - exact start time;
   - duration drift;
   - polarity correction bit;
   - transition/rise behavior.
4. Feed the libltc WAV to Arena through a real loopback device, then use the
   confirmed result to inform any production integration.
