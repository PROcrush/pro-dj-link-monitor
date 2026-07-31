# Timecode Lab Runbook

This runbook is for isolated testing only. It does not modify application
runtime state.

## Run Unit Tests

```bash
node --test labs/timecode-consistency/*.test.cjs
```

The command must complete without failures. The exact test count can grow as
new regression cases are added.

## Record Passive UDP Packets

Use this when a player is connected and playing:

```bash
node labs/timecode-consistency/record-prolink.cjs \
  --seconds 8 \
  --out labs/timecode-consistency/captures/prolink-latest.jsonl
```

The recorder only listens on UDP `50001` and `50002`. It does not transmit PRO DJ LINK packets.

## Replay A Capture

```bash
node labs/timecode-consistency/replay-capture.cjs \
  --file labs/timecode-consistency/captures/prolink-latest.jsonl \
  --fps 30
```

If the capture contains only `0x28` beat packets and no absolute position or beat grid, the correct result is no timecode:

```text
sources=none
elapsed=-
timecode=-
```

That is intentional. Emitting `00:00:00:00` from missing timing data is a bug.

## Optional Read-Only App State

When the app Web Console is running:

```bash
curl -s http://127.0.0.1:7072/state.json
```

This can prove whether the running app already has `deck.elapsedMs`, `deck.beatGrid`, and `deck.progress`. If it returns empty, the app is not exposing the Web Console at that moment.

## Capture privacy

The `captures/` directory is intentionally ignored by Git. Live captures can
contain precise timestamps, private network addresses, device identifiers and
track metadata. Before sharing a fixture, replace the live data with a small,
deterministic synthetic example or document how every identifying field was
sanitized.

A capture containing beat packets but no absolute position or usable beat grid
must replay with unavailable timing. Emitting a false `00:00:00:00` because
JavaScript coerced `null` to `0` is a regression covered by tests.
