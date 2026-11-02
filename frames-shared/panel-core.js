// panel-core: the Streamer.bot transport every Frames theme loads. Adapted from Tally's.
//
// Serve this file at /frames-shared/panel-core.js. Panels load it by that absolute path
// and listen for window CustomEvents:
//
//   linescore:update, detail = the full payload (see docs/THEMING.md)
//   linescore:error,  detail = { type, message }, when the push action fails (optional)
//
// It speaks Streamer.bot's WebSocket protocol with a raw browser WebSocket (no library,
// no CDN, so it works offline in the OBS CEF browser source), subscribes to General.Custom
// and dispatches every broadcast whose data.type is one of those.
//
// Streamer.bot has no state-on-connect replay. We recreate it: after the Subscribe is
// acknowledged we fire a DoAction naming the push action, which re-broadcasts the current
// line score, so a source added mid-match paints immediately.
//
// Config (set a window global before this loads, or, only when served over http://, pass
// a URL query; file:// OBS sources cannot take query params):
//   window.__SB_WS_URL      SB WebSocket Server URL (default ws://127.0.0.1:8080/)
//   ?sbport=<n>             shorthand for ws://127.0.0.1:<n>/  (http:// sources only)
//   window.__SB_SYNC_ACTION action to DoAction on connect (default 'Linescore Push'; '' to skip)
//   window.__SB_DEBUG / ?sbdebug=1  log the connection and message flow

(() => {
  'use strict';

  const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(''); } })();
  // Only a real port number reaches the URL, so a query can't point this anywhere else.
  const sbport = q.get('sbport') || '';
  const port = /^\d{1,5}$/.test(sbport) && +sbport >= 1 && +sbport <= 65535 ? sbport : '8080';
  const WS_URL = window.__SB_WS_URL || `ws://127.0.0.1:${port}/`;
  const SYNC_ACTION = (typeof window.__SB_SYNC_ACTION === 'string')
    ? window.__SB_SYNC_ACTION
    : 'Linescore Push';
  const DEBUG = q.get('sbdebug') === '1' || !!window.__SB_DEBUG;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 15000;
  const SYNC_FALLBACK_MS = 400; // fire the sync DoAction even if the ack shape isn't recognized

  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let msgId = 0;

  const log = (...a) => { if (DEBUG) console.log('[frames panel-core]', ...a); };

  // Themes may style body.offline.
  const setOffline = (off) => { if (document.body) document.body.classList.toggle('offline', off); };

  function connect() {
    log('connecting to', WS_URL);
    ws = new WebSocket(WS_URL);

    let subId = null;
    let syncFired = false;
    let syncTimer = null;

    function fireSync() {
      if (syncFired) return;
      syncFired = true;
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      if (!SYNC_ACTION) return;
      log('requesting state via DoAction', JSON.stringify(SYNC_ACTION));
      ws.send(JSON.stringify({
        request: 'DoAction',
        id: String(++msgId),
        action: { name: SYNC_ACTION },
        args: { reason: 'overlay-connect' },
      }));
    }

    ws.onopen = () => {
      reconnectDelay = RECONNECT_BASE_MS;
      setOffline(false);

      // The event-SOURCE key is LOWERCASE ('general') in the Subscribe request even
      // though delivered events carry a capitalized source ('General'). Capital
      // 'General' here silently receives nothing.
      subId = String(++msgId);
      ws.send(JSON.stringify({ request: 'Subscribe', id: subId, events: { general: ['Custom'] } }));
      syncTimer = setTimeout(fireSync, SYNC_FALLBACK_MS);
    };

    ws.onmessage = (evt) => {
      let m;
      try { m = JSON.parse(evt.data); } catch { return; }

      // Subscribe acknowledgement (a response carrying our id, not an event): now it's
      // safe to ask for the state re-broadcast.
      if (m && m.id && m.id === subId && !m.event) {
        fireSync();
        return;
      }

      if (m && m.event && m.event.source === 'General' && m.event.type === 'Custom') {
        let d = m.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
        if (d && (d.type === 'linescore:update' || d.type === 'linescore:error')) {
          log('General.Custom', d.type);
          window.dispatchEvent(new CustomEvent(d.type, { detail: d }));
        }
      }
    };

    ws.onclose = () => { setOffline(true); log('closed; reconnecting'); scheduleReconnect(); };
    ws.onerror = () => { log('WebSocket error: is SB\'s WebSocket Server enabled on', WS_URL, 'with authentication OFF?'); };
  }

  function scheduleReconnect() {
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
      connect();
    }, reconnectDelay);
  }

  function init() { setOffline(true); connect(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
