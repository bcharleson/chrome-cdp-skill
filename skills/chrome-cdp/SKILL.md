---
name: chrome-cdp
description: Interact with local Chrome or Edge browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome/Edge)
---

# Chrome & Edge CDP

Lightweight Chrome/Edge DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

Uses a **Persistent Browser Multiplexer Daemon** (`\\.\pipe\cdp-browser-chrome` / `\\.\pipe\cdp-browser-edge`) that holds a **single** browser-level WebSocket open for 24 hours (with a 4-minute keepalive ping) and multiplexes `list`, `open`, and all tab `sessionId`s over that single connection. You only click **"Allow"** **once** when the daemon first connects—never again for `list`, `open`, switching tabs, or new tabs.

## Prerequisites

- **Chrome:** open `chrome://inspect/#remote-debugging` and toggle the switch
- **Edge:** open `edge://inspect/#remote-debugging` and toggle the switch (use `--browser edge` or `edge-cdp/scripts/cdp.mjs`)
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

## Commands

All commands use `scripts/cdp.mjs` (pass `--browser edge` to target Microsoft Edge, or use `edge-cdp/scripts/cdp.mjs`). The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`).

### List open pages

```bash
scripts/cdp.mjs list
scripts/cdp.mjs --browser edge list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab (reuses persistent browser session — no extra Allow prompt!)
scripts/cdp.mjs stop    [target]               # stop daemon (or detach a single target)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.
