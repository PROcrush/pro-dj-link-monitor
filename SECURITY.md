# Security policy

## Supported code

Security fixes are applied to the current `main` branch. Until signed releases
exist, source builds should be treated as development software.

## Reporting a vulnerability

Use GitHub's **Security → Report a vulnerability** flow. Do not open a public
issue containing a live packet capture, track metadata, device identifiers,
network addresses or an exploit. Include the smallest sanitized reproduction
that still demonstrates the problem.

## Network threat model

- Raw WebSocket output is loopback-only by default.
- The Web Console is loopback-only by default. Enabling its LAN switch exposes
  deck state and diagnostic endpoints to the selected trusted network without
  account authentication or TLS.
- Never expose ports 7071 or 7072 through router forwarding, a public Wi-Fi
  network, a cloud tunnel or an untrusted VLAN.
- OSC, TCNet and PRO DJ LINK use unauthenticated local-network protocols. Keep
  DJ and show-control networks segmented from untrusted clients.

## Capture and log privacy

Packet captures can contain precise timestamps, private IP addresses, device
models and track metadata. Captures are ignored by Git and must be sanitized
before they are attached to any issue or pull request. Automatic waveform
failure logs are privacy-reduced on disk; an explicit diagnostic export may
contain more detail and must be reviewed before sharing.
