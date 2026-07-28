# Launch playbook

Where beamdesk gets attention, and the text to post. Everything here is written
to be honest about what the tool is — a **visible, consent-based** remote-control
tool for your own machines. That framing is not a compliance footnote; it is the
reason the project is postable at all. A "stealth remote access" angle gets a
repo reported and removed, not upvoted.

Post the demo GIF with every one of these. Nothing converts a visual tool like
seeing it move.

---

## The one-liner (reuse everywhere)

> Control your own machine from any browser — screen at 60fps, keyboard, mouse,
> and audio. H.264 over QUIC, no relay server, no account.

---

## Show HN

**Title:** Show HN: Beamdesk – Browser remote desktop over QUIC, no relay server

**Body:**

I wanted to control my desktop from my phone without signing up for anything or
routing my screen through someone else's servers, so I built beamdesk.

You run an agent on the machine you want to control and open a web client — which
the agent serves itself — from any other device. The client talks directly to the
agent; there is no relay, no VPS, no account.

The parts I found interesting to build:

- Screen is H.264, encoded in-process (hardware encoder when there is one),
  decoded in the browser with WebCodecs. It came out to ~7.4 KB/frame versus
  ~267 KB for the MJPEG approach I started with — about 35x less bandwidth.
- Video rides QUIC/WebTransport when the browser and network allow it, and falls
  back to a WebSocket otherwise, so one lost packet does not stall the whole
  stream.
- Bitrate, resolution and frame rate step down automatically on a link that
  cannot keep up, instead of queueing and falling behind.
- On a phone, touch gestures map to a trackpad (drag = move, long-press = right
  click, two fingers = scroll) and a hidden input raises the soft keyboard so you
  can actually type to the remote machine.

It is deliberately visible and consent-based: a shared secret, a certificate you
approve, and it shows on the controlled machine that it is running. No stealth,
by design.

Repo: https://github.com/Pradhumn115/beamdesk

Happy to go into the QUIC-vs-WebSocket handling or the adaptive controller if
anyone is interested.

---

## Reddit

Good subreddits, most-relevant first. Read each one's self-promotion rule before
posting; several require you to be a regular contributor.

- r/selfhosted — the core audience. Lead with "no relay, no account, runs on your
  own machines."
- r/webdev — lead with the WebCodecs + WebTransport engineering.
- r/javascript — same, framed as a TypeScript project.
- r/coolgithubprojects — built for exactly this.
- r/opensource — MIT, self-hostable.

**r/selfhosted title:** I built a browser remote-desktop that needs no relay
server or account — direct device-to-device, H.264 over QUIC

**Body:** (same shape as the Show HN body, a touch more casual, GIF at the top.)

---

## Places that aggregate, low effort

- **Awesome lists** — open a PR adding beamdesk to `awesome-selfhosted`,
  `awesome-remote-desktop` (search for current ones). These send steady traffic
  for years.
- **Product Hunt** — works for visual tools; needs the GIF and a clear tagline.
- **lobste.rs** — if you have an account; the crowd rewards the QUIC/WebCodecs
  engineering angle.
- **Twitter/X and Mastodon** — short clip of the phone driving the desktop, the
  one-liner, the link.

---

## Before posting, the checklist

- [ ] Demo GIF is in the README and loads on github.com
- [ ] `npm start` works from a fresh clone on a machine that is not yours
- [ ] The certificate step in the README is followed exactly once and works
- [ ] Description and topics are set on the repo (done)
- [ ] You can answer "how is this different from VNC / RustDesk?" in one sentence
      — direct, browser-native, no client to install, H.264-over-QUIC

The honest one-sentence differentiator: **the client is just a URL — nothing to
install on the controlling device, and nothing in the middle.**
