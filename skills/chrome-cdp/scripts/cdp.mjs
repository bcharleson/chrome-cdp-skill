#!/usr/bin/env node
// cdp - lightweight Chrome & Edge DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Zero-Prompt Persistent Browser Multiplexer Architecture:
// 1. Dedicated CDP Profile Mode (Default on Windows):
//    Connects to (or auto-launches) Chrome (port 9224) or Edge (port 9223) with
//    `--remote-debugging-port` and `--user-data-dir=<LOCALAPPDATA>/.../CDP-Profile`.
//    This inherits all Windows OS CAC smartcard certificates, Windows Hello passkeys,
//    and HKLM Group Policies (Menlo PAC proxy, DoD Root CAs) while NEVER showing
//    an "Allow debugging?" modal prompt!
// 2. Default Profile Mode (`--default-profile` or `CDP_DEFAULT_PROFILE=1`):
//    Uses `DevToolsActivePort` from `chrome://inspect/#remote-debugging` with a
//    single persistent browser multiplexer daemon (`\\.\pipe\cdp-browser-*`) so
//    "Allow debugging?" only fires once per 24h session.

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn, spawnSync } from 'child_process';
import net from 'net';

const TIMEOUT = 25000;
const CONNECT_TIMEOUT = 45000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
const KEEPALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutes
const DAEMON_CONNECT_RETRIES = 150;       // 45s max wait
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === 'win32';
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}

const DEFAULT_PORTS = {
  chrome: parseInt(process.env.CDP_CHROME_PORT || '9224', 10),
  edge: parseInt(process.env.CDP_EDGE_PORT || '9223', 10),
  brave: parseInt(process.env.CDP_BRAVE_PORT || '9225', 10),
};

function detectBrowserFromArgs(rawArgs) {
  const scriptPath = (process.argv[1] || '').toLowerCase();
  let browser = (process.env.CDP_BROWSER || (scriptPath.includes('edge-cdp') ? 'edge' : 'chrome')).toLowerCase();
  let useDefaultProfile = process.env.CDP_DEFAULT_PROFILE === '1' || process.env.CDP_DEFAULT_PROFILE === 'true';
  const filteredArgs = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if ((a === '--browser' || a === '-b') && rawArgs[i + 1]) {
      browser = rawArgs[++i].toLowerCase();
    } else if (a.startsWith('--browser=')) {
      browser = a.slice('--browser='.length).toLowerCase();
    } else if (a === '--default-profile') {
      useDefaultProfile = true;
    } else {
      filteredArgs.push(a);
    }
  }
  if (browser.includes('edge') || browser === 'msedge') browser = 'edge';
  else if (browser.includes('brave')) browser = 'brave';
  else browser = 'chrome';
  return { browser, useDefaultProfile, args: filteredArgs };
}

function pagesCachePath(browser) {
  return resolve(RUNTIME_DIR, `pages-${browser}.json`);
}
const LEGACY_PAGES_CACHE = resolve(RUNTIME_DIR, 'pages.json');

function browserSockPath(browser) {
  return IS_WINDOWS
    ? `\\\\.\\pipe\\cdp-browser-${browser}`
    : resolve(RUNTIME_DIR, `cdp-browser-${browser}.sock`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function spawnDetached(exe, args, env = process.env) {
  if (IS_WINDOWS) {
    // Launch synchronously via WMI Win32_Process.Create so the background daemon /
    // browser is created by WmiPrvSE.exe completely outside any parent shell Job Object.
    const cmdLine = [exe, ...args]
      .map(a => (/\s/.test(String(a)) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a)))
      .join(' ');
    const escapedForPs = cmdLine.replace(/'/g, "''");
    spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-Command',
      `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${escapedForPs}'; ProcessStartupInformation = $si } | Out-Null`,
    ], { stdio: 'ignore', windowsHide: true, env });
    return;
  }
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', env });
  child.unref();
}

function findBrowserExecutable(browser = 'chrome') {
  if (!IS_WINDOWS) return null;
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
  const candidates = browser === 'edge'
    ? [
        resolve(pf86, 'Microsoft/Edge/Application/msedge.exe'),
        resolve(pf, 'Microsoft/Edge/Application/msedge.exe'),
        resolve(local, 'Microsoft/Edge/Application/msedge.exe'),
      ]
    : [
        resolve(pf, 'Google/Chrome/Application/chrome.exe'),
        resolve(pf86, 'Google/Chrome/Application/chrome.exe'),
        resolve(local, 'Google/Chrome/Application/chrome.exe'),
      ];
  return candidates.find(p => existsSync(p)) || null;
}

async function fetchDebuggerWsUrlFromPort(port, host = '127.0.0.1') {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    return data.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

async function ensureZeroPromptBrowserWsUrl(browser = 'chrome') {
  const host = process.env.CDP_HOST || '127.0.0.1';
  const port = DEFAULT_PORTS[browser] || 9224;

  // 1. Check if browser CDP HTTP endpoint is already listening on its dedicated port
  let wsUrl = await fetchDebuggerWsUrlFromPort(port, host);
  if (wsUrl) return wsUrl;

  // 2. On Windows, auto-launch the browser with its dedicated CDP profile so no "Allow" prompt ever fires
  const exe = findBrowserExecutable(browser);
  if (exe) {
    const baseLocal = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
    const profileDir = browser === 'edge'
      ? resolve(baseLocal, 'Microsoft/Edge/CDP-Profile')
      : resolve(baseLocal, 'Google/Chrome/CDP-Profile');
    try { mkdirSync(profileDir, { recursive: true }); } catch {}

    spawnDetached(exe, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]);

    for (let i = 0; i < 25; i++) {
      await sleep(300);
      wsUrl = await fetchDebuggerWsUrlFromPort(port, host);
      if (wsUrl) return wsUrl;
    }
  }
  return null;
}

function getDefaultProfileWsUrl(browser = 'chrome') {
  const home = homedir();
  const baseLocal = process.env.LOCALAPPDATA || resolve(home, 'AppData/Local');

  const browserMapWin = {
    chrome: ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing', 'Chromium'],
    edge: ['Microsoft/Edge', 'Microsoft/Edge Beta', 'Microsoft/Edge Dev'],
    brave: ['BraveSoftware/Brave-Browser'],
  };
  const browserMapMac = {
    chrome: [
      'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
      'Chromium', 'Helium', 'Thorium', 'Vivaldi',
      'BraveSoftware/Brave-Browser', 'Microsoft Edge',
    ],
    edge: ['Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev'],
    brave: ['BraveSoftware/Brave-Browser'],
  };
  const browserMapLinux = {
    chrome: [
      'google-chrome', 'google-chrome-beta', 'google-chrome-unstable',
      'chromium', 'helium', 'thorium', 'vivaldi', 'vivaldi-snapshot',
      'BraveSoftware/Brave-Browser', 'microsoft-edge',
    ],
    edge: ['microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev'],
    brave: ['BraveSoftware/Brave-Browser'],
  };
  // Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
  const flatpakBrowsers = [
    ['org.chromium.Chromium', 'chromium'],
    ['com.google.Chrome', 'google-chrome'],
    ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
    ['com.microsoft.Edge', 'microsoft-edge'],
    ['com.vivaldi.Vivaldi', 'vivaldi'],
  ];

  const winDirs = browserMapWin[browser] || browserMapWin.chrome;
  const macDirs = browserMapMac[browser] || browserMapMac.chrome;
  const linuxDirs = browserMapLinux[browser] || browserMapLinux.chrome;

  const candidates = [
    process.env.CDP_PORT_FILE,
    ...(IS_WINDOWS ? winDirs.flatMap(b => [
      resolve(baseLocal, b, 'CDP-Profile/DevToolsActivePort'),
      resolve(baseLocal, b, 'User Data/DevToolsActivePort'),
      resolve(baseLocal, b, 'User Data/Default/DevToolsActivePort'),
    ]) : []),
    ...macDirs.flatMap(b => [
      resolve(home, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(home, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxDirs.flatMap(b => [
      resolve(home, '.config', b, 'DevToolsActivePort'),
      resolve(home, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    ...flatpakBrowsers.flatMap(([appId, name]) => [
      resolve(home, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(home, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
  ].filter(Boolean);

  const portFile = candidates.find(p => existsSync(p));
  if (!portFile) {
    const inspectUrl = browser === 'edge' ? 'edge://inspect/#remote-debugging' : 'chrome://inspect/#remote-debugging';
    throw new Error(`No DevToolsActivePort found for ${browser}. Enable remote debugging at ${inspectUrl}`);
  }
  const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  const host = process.env.CDP_HOST || '127.0.0.1';
  return `ws://${host}:${lines[0].trim()}${lines[1].trim()}`;
}

async function resolveWsUrl(browser = 'chrome', useDefaultProfile = false) {
  if (IS_WINDOWS && !useDefaultProfile && !process.env.CDP_PORT_FILE) {
    const zeroPromptUrl = await ensureZeroPromptBrowserWsUrl(browser);
    if (zeroPromptUrl) return zeroPromptUrl;
  }
  return getDefaultProfileWsUrl(browser);
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        try { this.#ws?.close(); } catch {}
        rej(new Error('WebSocket connect timeout (waiting for Allow debugging approval)'));
      }, CONNECT_TIMEOUT);
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => { clearTimeout(timer); res(); };
      this.#ws.onerror = (e) => { clearTimeout(timer); rej(new Error('WebSocket error: ' + (e.message || e.type))); };
      this.#ws.onclose = () => {
        clearTimeout(timer);
        for (const [, { reject }] of this.#pending) {
          reject(new Error('CDP WebSocket closed'));
        }
        this.#pending.clear();
        this.#closeHandlers.forEach(h => h());
      };
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { try { this.#ws?.close(); } catch {} }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

function isInternalUrl(url = '') {
  return (
    url.startsWith('chrome://') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('extension://')
  );
}

async function getPages(cdp, browser = 'chrome') {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page' && !isInternalUrl(t.url));
  try {
    writeFileSync(pagesCachePath(browser), JSON.stringify(pages), { mode: 0o600 });
    writeFileSync(LEGACY_PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
  } catch {}
  return pages;
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = (p.title || '').substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath, targetId) {
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch {}
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch {}
  }

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || 'unknown').slice(0, 8)}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      throw new Error(`Only http/https URLs allowed, got: ${url}`);
  } catch (e) {
    if (e.message.startsWith('Only')) throw e;
    throw new Error(`Invalid URL: ${url}`);
  }
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Persistent Browser Multiplexer Daemon (1 WebSocket per Browser)
// ---------------------------------------------------------------------------

async function runBrowserDaemon(browser = 'chrome', useDefaultProfile = false) {
  const sp = browserSockPath(browser);

  const cdp = new CDP();
  try {
    const wsUrl = await resolveWsUrl(browser, useDefaultProfile);
    await cdp.connect(wsUrl);
    await getPages(cdp, browser);
  } catch (e) {
    process.stderr.write(`Daemon (${browser}): cannot connect: ${e.message}\n`);
    process.exit(1);
  }

  const sessions = new Map();

  async function getOrAttachSession(targetId) {
    if (sessions.has(targetId)) {
      return sessions.get(targetId);
    }
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessions.set(targetId, res.sessionId);
    return res.sessionId;
  }

  async function resolveTargetId(targetPrefix) {
    let pages = [];
    const cacheFile = pagesCachePath(browser);
    if (existsSync(cacheFile)) {
      try { pages = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch {}
    }
    try {
      return resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target');
    } catch {
      pages = await getPages(cdp, browser);
      return resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
    }
  }

  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    clearInterval(keepaliveTimer);
    clearTimeout(idleTimer);
    try { server.close(); } catch {}
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId) sessions.delete(params.targetId);
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.targetId) {
      sessions.delete(params.targetId);
    } else if (params.sessionId) {
      for (const [tid, sid] of sessions.entries()) {
        if (sid === params.sessionId) sessions.delete(tid);
      }
    }
  });

  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }
  const keepaliveTimer = setInterval(async () => {
    try {
      await cdp.send('Browser.getVersion', {}, undefined, 5000);
    } catch {}
  }, KEEPALIVE_INTERVAL);

  async function handleCommand({ cmd, targetPrefix, args = [] }) {
    resetIdle();
    try {
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp, browser);
          return { ok: true, result: formatPageList(pages) };
        }
        case 'list_raw': {
          const pages = await getPages(cdp, browser);
          return { ok: true, result: JSON.stringify(pages) };
        }
        case 'open': {
          const url = args[0] || 'about:blank';
          const { targetId } = await cdp.send('Target.createTarget', { url });
          try { await getOrAttachSession(targetId); } catch {}
          const pages = await getPages(cdp, browser);
          if (!pages.some(p => p.targetId === targetId)) {
            pages.push({ targetId, title: url, url });
            try {
              writeFileSync(pagesCachePath(browser), JSON.stringify(pages), { mode: 0o600 });
              writeFileSync(LEGACY_PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
            } catch {}
          }
          return { ok: true, result: `Opened new tab: ${targetId.slice(0, 8)}  ${url}` };
        }
        case 'stop': {
          if (targetPrefix) {
            const tid = await resolveTargetId(targetPrefix).catch(() => null);
            if (tid && sessions.has(tid)) {
              const sid = sessions.get(tid);
              sessions.delete(tid);
              await cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
            }
            return { ok: true, result: '' };
          }
          return { ok: true, result: '', stopAfter: true };
        }
      }

      if (!targetPrefix) {
        return { ok: false, error: 'Target ID required. Run "cdp list" first.' };
      }
      const targetId = await resolveTargetId(targetPrefix);
      let sessionId = await getOrAttachSession(targetId);

      async function runPageOp(sid) {
        switch (cmd) {
          case 'snap': case 'snapshot': return await snapshotStr(cdp, sid, true);
          case 'eval': return await evalStr(cdp, sid, args[0]);
          case 'shot': case 'screenshot': return await shotStr(cdp, sid, args[0], targetId);
          case 'html': return await htmlStr(cdp, sid, args[0]);
          case 'nav': case 'navigate': return await navStr(cdp, sid, args[0]);
          case 'net': case 'network': return await netStr(cdp, sid);
          case 'click': return await clickStr(cdp, sid, args[0]);
          case 'clickxy': return await clickXyStr(cdp, sid, args[0], args[1]);
          case 'type': return await typeStr(cdp, sid, args[0]);
          case 'loadall': return await loadAllStr(cdp, sid, args[0], args[1] ? parseInt(args[1]) : 1500);
          case 'evalraw': return await evalRawStr(cdp, sid, args[0], args[1]);
          default: throw new Error(`Unknown command: ${cmd}`);
        }
      }

      let result;
      try {
        result = await runPageOp(sessionId);
      } catch (err) {
        if (/Session with given id not found|Target closed|detached/i.test(err.message)) {
          sessions.delete(targetId);
          sessionId = await getOrAttachSession(targetId);
          result = await runPageOp(sessionId);
        } else {
          throw err;
        }
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const server = net.createServer((conn) => {
    conn.on('error', () => {});
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartBrowserDaemon(browser = 'chrome', useDefaultProfile = false) {
  const sp = browserSockPath(browser);
  // 1. Reuse existing persistent browser daemon if running
  try { return await connectToSocket(sp); } catch {}

  // 2. Ensure target browser CDP endpoint is ready (auto-launches zero-prompt CDP profile if needed)
  await resolveWsUrl(browser, useDefaultProfile);

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // 3. Spawn persistent browser daemon outside parent Job Object
  const daemonArgs = [process.argv[1], '_daemon', `--browser=${browser}`];
  if (useDefaultProfile) daemonArgs.push('--default-profile');
  spawnDetached(process.execPath, daemonArgs, {
    ...process.env,
    CDP_BROWSER: browser,
    ...(useDefaultProfile ? { CDP_DEFAULT_PROFILE: '1' } : {}),
  });

  let prompted = false;
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
    if (i === 8 && !prompted && useDefaultProfile) {
      prompted = true;
      const bName = browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
      process.stderr.write(`Waiting for one-time "Allow debugging?" approval in ${bName}...\n`);
    }
  }
  const bName = browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome';
  throw new Error(`Daemon failed to start for ${bName}.`);
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome & Edge DevTools Protocol CLI (no Puppeteer)

Usage: cdp [--browser chrome|edge] <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression
  shot  <target> [file]             Screenshot (default: screenshot-<target>.png in runtime dir); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates
  type    <target> <text>           Type text at current focus via Input.insertText
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
  open  [url]                       Open a new tab (zero-prompt persistent session)
  stop  [target]                    Stop daemon (or detach a single target)

Options:
  --browser, -b <chrome|edge>       Target browser (default: chrome, or CDP_BROWSER env var)
  --default-profile                 Use default profile DevToolsActivePort instead of zero-prompt CDP profile
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'net','network','click','clickxy','type','loadall','evalraw',
]);

async function main() {
  const { browser, useDefaultProfile, args: rawArgs } = detectBrowserFromArgs(process.argv.slice(2));
  const [cmd, ...args] = rawArgs;

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runBrowserDaemon(args[0] || browser, useDefaultProfile); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  if (cmd === 'list' || cmd === 'ls') {
    const conn = await getOrStartBrowserDaemon(browser, useDefaultProfile);
    const response = await sendCommand(conn, { cmd: 'list' });
    if (response.ok) {
      if (response.result) console.log(response.result);
    } else {
      console.error('Error:', response.error);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    const conn = await getOrStartBrowserDaemon(browser, useDefaultProfile);
    const response = await sendCommand(conn, { cmd: 'open', args: [url] });
    if (response.ok) {
      if (response.result) console.log(response.result);
    } else {
      console.error('Error:', response.error);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'stop') {
    const sp = browserSockPath(browser);
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop', targetPrefix: args[0] });
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    }
    return;
  }

  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
  } else if (cmd === 'type') {
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
  } else if (cmd === 'evalraw') {
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(' ');
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const conn = await getOrStartBrowserDaemon(browser, useDefaultProfile);
  const response = await sendCommand(conn, { cmd, targetPrefix, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
