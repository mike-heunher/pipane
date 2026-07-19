# pipane

A clean web interface for the **pi coding agent**. Open any pi conversation in pipane, open any pipane conversation in pi -- full interop.

`pipane` runs a local backend that launches `pi` in RPC mode and streams agent messages to a browser UI over WebSocket.

## Walkthrough

Hero shot:

![pipane walkthrough hero](e2e/screenshots/walkthrough-hero.png)

Walkthrough (GIF):

![pipane walkthrough](e2e/videos/walkthrough.gif)

---

## Quickstarts

```bash
npm install -g pipane
```

If `pi` is missing, install it like this:

```bash
npm install -g @mariozechner/pi-coding-agent
```

### Explicit local dev deployment

On the pipane LXC, deploy the current working tree to the separate dev instance with:

```bash
npm run deploy:dev
```

This builds a release, atomically advances the `pipane-dev` systemd service, and verifies it on port `8223`. It does not change the production instance on port `8222`; source edits only become visible after the next explicit deployment.

```bash
journalctl -u pipane-dev -f
```

---

## What you get

- Session list and clean UI for `pi`
- Real-time tool calls and streaming output, nicely crafted
- A nice session picker
- A large amount high quality "vibe-code".

---

## Browser UI ownership

The renderer tree under [`src/client/ui/`](src/client/ui/) is maintained directly by pipane. It is derived from the final pi-mono `web-ui` release (`v0.75.3`) with pipane's flat message renderer, steering editor, thinking display, attachment handling, and tool renderers integrated into one local path. Pipane does not patch or load an external `pi-web-ui` package. See [`UPSTREAM.md`](src/client/ui/UPSTREAM.md) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE)
