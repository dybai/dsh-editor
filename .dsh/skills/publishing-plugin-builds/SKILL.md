---
name: publishing-plugin-builds
description: Use when running `npm run build` in this project, when the maintainer reports GUI changes not visible after refresh, when claiming a client-side fix is live, or when the GUI shows stale plugin behavior (改动不可见/刷新无效/构建后未生效).
---

# Publishing Plugin Builds

## Overview

`npm run build` writes `client.js` to disk — that is NOT "deployed". The GUI is served the plugin bundle from the DSH host's **in-memory response table** (rev-keyed URLs, `cache-control: immutable`). A new generation reaches that table only via the client-hmr stat-poll calling `rebuilt()` **or an entry restart**. Empirically (byte-verified 2026-11-13): three consecutive builds were NOT served to a refreshing page until the entry was toggled — the poller's source code says it works, the served bytes said otherwise. **Never trust "it should hot-swap": verify the served bytes.**

## REQUIRED sequence (no step skipped)

1. `npm run build` — **read the output**; the bundler validates imports/exports and a failed build silently leaves the old bundle live. Expect `built client.js from src/client-entry.js (12 modules)`.
2. **Republish the generation**: `plugin_manager` → `set_plugin` action, target `include:dsh-editor`, `enabled:false` then `true` (an entry restart publishes through reconciliation). From the GUI: Settings → Plugins → toggle dsh-editor off/on.
3. **Verify served bytes** (ground truth, one paste):
   ```powershell
   $js = @'
   const {createHash} = require('crypto'); const {statSync} = require('fs');
   const b = statSync('D:/workspace/personal/dsh-editor/client.js');
   const parts = [String(b.mtimeMs), String(b.ctimeMs), String(b.size)];
   const h = createHash('sha1').update('plugin-artifact').update('\0');
   for (const p of parts) h.update(`${Buffer.byteLength(p)}:`).update(p);
   console.log(h.digest('hex').slice(0,12));
   '@
   $rev = node -e $js
   $u = "http://127.0.0.1:3080/plugins/??@dybai/dsh-editor/client.js&rev=$rev"
   $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15
   $t = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
   "served bytes=$($t.Length) has-marker=$($t.Contains('<unique marker from this build>'))"
   ```
   Substitute a marker that exists only in this build (a new string, class, or function name). Marker absent → go to step 2 again; entry restart is the only lever proven to work here.
4. Only then tell the maintainer: hard-refresh the GUI page (the refreshed index references the new `rev` URL, so an ordinary F5 normally suffices — hard refresh is belt-and-braces).

## Verify-before-claim checklist

- Disk: `client.js` mtime/size fresh + marker present.
- Served: step 3 says `has-marker=True`.
- Page: after refresh, the edited behavior is observable (or a `data-*`/marker probe confirms).

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The stat-poll hot-swaps in 500ms — no action needed" | The poller exists in source but failed to deliver across three verified builds in this environment. Bytes or it didn't happen. |
| "The maintainer restarted DSH / hard-refreshed" | Restart recomposes the graph, but a page keyed to the OLD rev URL keeps hitting the immutable in-memory response. Verify served bytes. |
| "Toggling the entry is heavy-handed" | It is the only lever byte-proven to publish here. It costs two tool calls. |
| "Build printed OK, so it's live" | Build prints OK while serving the previous generation. Build success ≠ published. |
| "The browser cache is the problem — Ctrl+F5 fixes it" | `?rev=` already defeats browser cache. The staleness lives in the HOST response table, not the browser. |

## Red Flags — STOP

- Telling the maintainer "refresh and you'll see it" without step 3.
- Reasoning about the poller/HMR mechanism instead of running the byte check.
- Claiming a client-side fix is live with no served-bytes verification.

## Related

- Mechanism details: `dsh-client-modules` (`fetchBundle`/`rebuilt`/`bundleResource`, `cache-control: immutable`) and `dsh-client-hmr` (stat poll, SSE `/plugins/events`) in the DSH checkout.
