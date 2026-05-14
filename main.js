const { app, BrowserWindow, ipcMain, session, protocol } = require('electron');
const path  = require('path');
const axios = require('axios');
const http  = require('http');
const https = require('https');
const fs    = require('fs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'anime4up', privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }
]);

let mainWin;
let proxyServer     = null;
let currentProxyUrl = null;
let extractCount    = 0;
let gofileToken     = null;
let websiteToken    = '4fd6sg89d7s6';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const CHUNK_SIZE   = 4 * 1024 * 1024;
const MAX_PARALLEL = 4;

async function refreshWebsiteToken() {
  try {
    const res = await axios.get('https://gofile.io/dist/js/alljs.js', {
      headers: { 'User-Agent': UA },
      timeout: 10000,
    });
    const match = res.data.match(/wt\s*[:=]\s*["']([a-zA-Z0-9]+)["']/);
    if (match) { websiteToken = match[1]; console.log('wt refreshed:', websiteToken); }
  } catch (e) { console.error('wt refresh failed:', e.message); }
}

async function getGofileToken() {
  if (gofileToken) return gofileToken;
  const res = await axios.post('https://api.gofile.io/accounts', {}, {
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'Origin': 'https://gofile.io', 'Referer': 'https://gofile.io/' },
    timeout: 10000,
  });
  const token = res.data?.data?.token;
  if (!token) throw new Error('فشل الحصول على توكن gofile');
  gofileToken = token;
  console.log('Gofile token created:', token);
  return token;
}

function startProxyServer() {
  proxyServer = http.createServer(async (req, res) => {
    if (!currentProxyUrl) { res.writeHead(404); return res.end(); }

    const isGofile  = currentProxyUrl.includes('gofile.io');
    const parsedUrl = (() => { try { return new URL(currentProxyUrl); } catch { return null; } })();
    if (!parsedUrl) { res.writeHead(400); return res.end(); }

    const isHttps = parsedUrl.protocol === 'https:';

    const makeHeaders = (extra = {}) => ({
      'User-Agent': UA,
      'Referer':    isGofile ? 'https://gofile.io/' : parsedUrl.origin + '/',
      'Origin':     isGofile ? 'https://gofile.io'  : parsedUrl.origin,
      'Accept':     '*/*',
      'Connection': 'keep-alive',
      ...(isGofile && gofileToken ? {
        'Cookie':        `accountToken=${gofileToken}`,
        'Authorization': `Bearer ${gofileToken}`,
      } : {}),
      ...extra,
    });

    const ext  = currentProxyUrl.split('?')[0].toLowerCase();
    const mime =
      ext.endsWith('.mkv')  ? 'video/x-matroska' :
      ext.endsWith('.webm') ? 'video/webm' :
      ext.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' :
      'video/mp4';

    let totalSize = 0;
    if (isGofile) {
      try {
        const headRes = await axios.head(currentProxyUrl, {
          headers: makeHeaders(), timeout: 10000, maxRedirects: 5,
        });
        totalSize = parseInt(headRes.headers['content-length'] || '0', 10);
      } catch (e) { console.error('HEAD failed:', e.message); }
    }

    const rangeHeader = req.headers['range'];

    if (!isGofile || !rangeHeader || !totalSize) {
      const transport = isHttps ? https : http;
      const upstream  = transport.request({
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || (isHttps ? 443 : 80),
        path:     parsedUrl.pathname + parsedUrl.search,
        method:   'GET',
        headers:  makeHeaders(rangeHeader ? { Range: rangeHeader } : {}),
        timeout:  120000,
      }, (upRes) => {
        const resHeaders = {
          'Content-Type':                mime,
          'Accept-Ranges':               'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'no-cache',
        };
        if (upRes.headers['content-length']) resHeaders['Content-Length'] = upRes.headers['content-length'];
        if (upRes.headers['content-range'])  resHeaders['Content-Range']  = upRes.headers['content-range'];
        res.writeHead(upRes.statusCode || 200, resHeaders);
        upRes.pipe(res);
        req.on('close', () => { try { upRes.destroy(); } catch {} });
      });
      upstream.on('error', (e) => {
        console.error('proxy error:', e.message);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.on('timeout', () => {
        upstream.destroy();
        if (!res.headersSent) res.writeHead(504);
        res.end();
      });
      upstream.end();
      return;
    }

    let start = 0;
    let end   = totalSize - 1;
    const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (rangeMatch) {
      start = parseInt(rangeMatch[1], 10);
      end   = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : totalSize - 1;
    }
    const length = end - start + 1;

    res.writeHead(206, {
      'Content-Type':                mime,
      'Content-Length':              String(length),
      'Content-Range':               `bytes ${start}-${end}/${totalSize}`,
      'Accept-Ranges':               'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });

    const chunks = [];
    let pos = start;
    while (pos <= end) {
      const chunkEnd = Math.min(pos + CHUNK_SIZE - 1, end);
      chunks.push({ start: pos, end: chunkEnd });
      pos = chunkEnd + 1;
    }

    const transport = isHttps ? https : http;
    let aborted = false;
    req.on('close', () => { aborted = true; });

    const fetchChunk = ({ start: cs, end: ce }) =>
      new Promise((resolve, reject) => {
        const upReq = transport.request({
          hostname: parsedUrl.hostname,
          port:     parsedUrl.port || (isHttps ? 443 : 80),
          path:     parsedUrl.pathname + parsedUrl.search,
          method:   'GET',
          headers:  makeHeaders({ Range: `bytes=${cs}-${ce}` }),
          timeout:  60000,
        }, (upRes) => {
          const bufs = [];
          upRes.on('data',  d => bufs.push(d));
          upRes.on('end',   () => resolve(Buffer.concat(bufs)));
          upRes.on('error', reject);
        });
        upReq.on('error',   reject);
        upReq.on('timeout', () => { upReq.destroy(); reject(new Error('chunk timeout')); });
        upReq.end();
      });

    try {
      for (let i = 0; i < chunks.length; i += MAX_PARALLEL) {
        if (aborted) break;
        const group   = chunks.slice(i, i + MAX_PARALLEL);
        const buffers = await Promise.all(group.map(fetchChunk));
        for (const buf of buffers) {
          if (aborted) break;
          res.write(buf);
        }
      }
    } catch (e) {
      console.error('chunked proxy error:', e.message);
    } finally {
      res.end();
    }
  });

  proxyServer.listen(19876, '127.0.0.1', () => {
    console.log('Proxy server running on http://127.0.0.1:19876');
  });
}

function safeOrigin(url) {
  try { const o = new URL(url).origin; return (o && o !== 'null') ? o : null; } catch { return null; }
}

function isRealVideoUrl(u) {
  if (!u.startsWith('http')) return false;
  const p = u.split('?')[0].toLowerCase();
  if (!p.endsWith('.mp4') && !p.endsWith('.m3u8') && !p.endsWith('.ts') &&
      !p.endsWith('.mkv') && !p.endsWith('.webm')) return false;
  if (p.endsWith('.html') || p.endsWith('.htm')) return false;
  if (u.includes('/embed') || u.includes('/embed-')) return false;
  if (u.includes('.jpg') || u.includes('.jpeg') || u.includes('.png') || u.includes('.gif')) return false;
  if (u.includes('.css') || u.includes('.js')) return false;
  if (u.includes('googleapis') || u.includes('google-analytics')) return false;
  if (u.includes('adsco') || u.includes('cdn4ads')) return false;
  if (u.includes('cassenovene') || u.includes('nodusdehorn')) return false;
  if (u.includes('slavir') || u.includes('bvtpk') || u.includes('visage')) return false;
  if (u.includes('rum?')) return false;
  return true;
}

function createWindow() {
  refreshWebsiteToken();
  setInterval(refreshWebsiteToken, 30 * 60 * 1000);
  startProxyServer();

  mainWin = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    frame: false, backgroundColor: '#0d0d1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const emptyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );
  const emptyResponse = () => new Response(new Uint8Array(emptyPng), {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(emptyPng.byteLength), 'Access-Control-Allow-Origin': '*' }
  });

  protocol.handle('anime4up', async (request) => {
    try {
      const reqUrl   = new URL(request.url);
      const imageUrl = decodeURIComponent(reqUrl.searchParams.get('url') || '');
      if (!imageUrl || !imageUrl.startsWith('http')) return emptyResponse();
      const res = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': UA, 'Referer': 'https://w1.anime4up.rest/',
          'Origin': 'https://w1.anime4up.rest',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Accept-Language': 'ar,en;q=0.9',
        },
        timeout: 30000, maxRedirects: 10, validateStatus: s => s < 500,
      });
      if (res.status === 404 || res.status === 403) return emptyResponse();
      const mime  = res.headers['content-type']?.split(';')[0] || 'image/jpeg';
      const uint8 = new Uint8Array(Buffer.from(res.data));
      return new Response(uint8, {
        status: 200,
        headers: { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*', 'Content-Length': String(uint8.byteLength) }
      });
    } catch (err) {
      if (!err.message?.includes('404')) console.error('PROTOCOL ERROR:', err.message);
      return emptyResponse();
    }
  });

  mainWin.loadFile('renderer/index.html');

  const spoofHeaders = (ses) => {
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      try {
        details.requestHeaders['Referer']    = 'https://w1.anime4up.rest/';
        details.requestHeaders['Origin']     = 'https://w1.anime4up.rest';
        details.requestHeaders['User-Agent'] = UA;
      } catch {}
      callback({ requestHeaders: details.requestHeaders });
    });
  };

  spoofHeaders(session.defaultSession);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(true));
  app.on('web-contents-created', (event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  ipcMain.on('minimize-window', () => mainWin.minimize());
  ipcMain.on('maximize-window', () => mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize());
  ipcMain.on('close-window',    () => mainWin.close());

  ipcMain.handle('fetch-page', async (event, url) => {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': UA, 'Referer': 'https://w1.anime4up.rest/',
        'Origin': 'https://w1.anime4up.rest', 'Accept-Language': 'ar,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 15000,
    });
    return res.data;
  });

  ipcMain.handle('fetch-image', async (event, url) => {
    if (!url) return '';
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': UA, 'Referer': 'https://w1.anime4up.rest/', 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        timeout: 12000, maxRedirects: 5,
      });
      const b64  = Buffer.from(res.data).toString('base64');
      const mime = res.headers['content-type']?.split(';')[0] || 'image/jpeg';
      return `data:${mime};base64,${b64}`;
    } catch { return ''; }
  });

  ipcMain.handle('proxy-video', async (_, videoUrl) => {
    currentProxyUrl = videoUrl;
    return 'http://127.0.0.1:19876/video';
  });

  ipcMain.handle('fetch-gofile', async (_, contentId) => {
    try {
      const token = await getGofileToken();
      let contentRes;
      const gofileGet = async (tok) => axios.get(
        `https://api.gofile.io/contents/${contentId}?wt=${websiteToken}&cache=true`,
        {
          headers: {
            'Authorization': `Bearer ${tok}`, 'X-Website-Token': websiteToken,
            'User-Agent': UA, 'Origin': 'https://gofile.io', 'Referer': 'https://gofile.io/',
          },
          timeout: 30000,
        }
      );
      try {
        contentRes = await gofileGet(token);
      } catch (e) {
        if (e.response?.status === 401) {
          console.log('Gofile token expired, refreshing...');
          gofileToken = null;
          contentRes = await gofileGet(await getGofileToken());
        } else { throw e; }
      }
      const data = contentRes.data?.data;
      if (!data) throw new Error('لم يتم إرجاع بيانات');
      const children = data.children ? Object.values(data.children) : [];
      const videos = children
        .filter(c => c.type === 'file' && (c.mimetype?.startsWith('video/') || c.name?.match(/\.(mp4|mkv|avi|mov|webm|m3u8|ts)$/i)))
        .map(c => ({ name: c.name, size: c.size, link: c.link, mimetype: c.mimetype, id: c.id }));
      const folders = children
        .filter(c => c.type === 'folder')
        .map(c => ({ name: c.name, id: c.id }));
      return { token, videos, folders, name: data.name || contentId };
    } catch (e) {
      console.error('fetch-gofile error:', e.message);
      if (e.response) console.error('fetch-gofile status:', e.response.status, JSON.stringify(e.response.data));
      return { error: e.message };
    }
  });

  const githubHeaders = { 'User-Agent': 'streamplay-app/1.0', 'Accept': 'application/vnd.github.v3+json' };

  ipcMain.handle('fetch-github-filelist', async () => {
    try {
      const res = await axios.get('https://api.github.com/repos/oman505/4kanime/contents/anime', { headers: githubHeaders, timeout: 15000 });
      const files = res.data.filter(f => f.type === 'file' && f.name.endsWith('.txt'))
        .map(f => ({ name: f.name.replace(/\.txt$/i, ''), download_url: f.download_url }));
      console.log('fetch-github-filelist OK:', files.map(f => f.name));
      return files;
    } catch (e) {
      console.error('fetch-github-filelist error:', e.message);
      if (e.response) console.error('status:', e.response.status, JSON.stringify(e.response.data));
      return { error: e.message };
    }
  });

  ipcMain.handle('load-gofile-list', async () => {
    try {
      const res = await axios.get('https://api.github.com/repos/oman505/4kanime/contents/anime', { headers: githubHeaders, timeout: 15000 });
      const files = res.data.filter(f => f.type === 'file' && f.name.endsWith('.txt'))
        .map(f => ({ name: f.name.replace(/\.txt$/i, ''), download_url: f.download_url }));
      console.log('load-gofile-list OK:', files.map(f => f.name));
      return files;
    } catch (e) {
      console.error('load-gofile-list error:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('fetch-github-file', async (_, url) => {
    try {
      const res = await axios.get(url, { headers: { 'User-Agent': 'streamplay-app/1.0' }, timeout: 15000 });
      const lines = String(res.data).split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.startsWith('http'));
      console.log('fetch-github-file:', lines.length, 'links from', url);
      return lines;
    } catch (e) {
      console.error('fetch-github-file error:', e.message);
      return { error: e.message };
    }
  });

  ipcMain.handle('fetch-anilist-titles', async (_, searchTitle) => {
    try {
      const query = `query ($search: String) { Media(search: $search, type: ANIME) { title { romaji english native userPreferred } synonyms } }`;
      const res = await axios.post('https://graphql.anilist.co',
        { query, variables: { search: searchTitle } },
        { headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeout: 8000 }
      );
      const media = res.data?.data?.Media;
      if (!media) return [];
      const titles = [
        media.title?.romaji, media.title?.english,
        media.title?.native, media.title?.userPreferred,
        ...(media.synonyms || []),
      ].filter(Boolean);
      console.log('AniList titles for "' + searchTitle + '":', titles);
      return titles;
    } catch (e) {
      console.error('fetch-anilist-titles error:', e.message);
      return [];
    }
  });

  ipcMain.handle('extract-video-url', async (_, serverUrl) => {
    console.log('EXTRACT CALLED WITH:', serverUrl);
    if (!serverUrl || !serverUrl.startsWith('http')) return null;

    const partition = `persist:extract_${++extractCount}`;
    const host      = (() => { try { return new URL(serverUrl).hostname; } catch { return ''; } })();
    const isDood    = host.includes('dood') || host.includes('dsvplay') || host.includes('doodstream');
    const isVoe     = host.includes('voe');
    const isLarhu   = host.includes('larhu');
    const isUqload  = host.includes('uqload');
    const isShare4  = host.includes('share4max');

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        show: false, width: 1280, height: 720, parent: mainWin,
        webPreferences: {
          contextIsolation: false, nodeIntegration: false,
          webSecurity: false, allowRunningInsecureContent: true, partition,
        },
      });

      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(true));

      win.webContents.session.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
        try {
          const origin = safeOrigin(details.url);
          if (origin) {
            details.requestHeaders['User-Agent'] = UA;
            if (!details.requestHeaders['Referer']) details.requestHeaders['Referer'] = origin + '/';
          }
        } catch {}
        callback({ requestHeaders: details.requestHeaders });
      });

      let resolved = false;
      const done = (url) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        setTimeout(() => { try { win.destroy(); } catch {} }, 500);
        resolve(url);
      };

      win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        const u = details.url;
        if (isRealVideoUrl(u)) { console.log('VIDEO CAPTURED:', u); callback({}); done(u); }
        else callback({});
      });

      win.webContents.on('did-finish-load', async () => {
        try {
          const waitTime = isDood ? 14000 : isVoe ? 6000 : isLarhu ? 8000 : isUqload ? 8000 : isShare4 ? 10000 : 8000;
          await new Promise(r => setTimeout(r, waitTime));
          if (resolved) return;

          const videoUrl = await win.webContents.executeJavaScript(`
            (() => {
              const host = location.hostname;
              if (host.includes('dood') || host.includes('dsvplay') || host.includes('doodstream')) {
                try {
                  const ds = window.dsplayer || window.ds_player;
                  if (ds) { const src = (ds.getSrc && ds.getSrc()) || ds.source; if (src && src.startsWith('http')) return src; }
                } catch {}
                const v = document.querySelector('video');
                if (v && v.src && v.src.startsWith('http') && !v.src.includes('blank')) return v.src;
                const allText = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\\n');
                const m1 = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.mp4[^"'\`\\s]*(?:token|hash|pass)[^"'\`\\s]*/i);
                const m2 = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.mp4[^"'\`\\s]*/i);
                return (m1 && m1[0]) || (m2 && m2[0]) || null;
              }
              if (host.includes('voe')) {
                try {
                  const srcs = window.sources || window.videoSources || window.hlsUrl;
                  if (typeof srcs === 'string' && srcs.startsWith('http')) return srcs;
                  if (srcs && typeof srcs === 'object') {
                    const hls = srcs.hls || srcs.mp4 || Object.values(srcs)[0];
                    if (hls && hls.startsWith('http')) return hls;
                  }
                } catch {}
                const allText = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\\n');
                const m1 = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.m3u8[^"'\`\\s]*/);
                const m2 = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.mp4[^"'\`\\s]*/);
                return (m1 && m1[0]) || (m2 && m2[0]) || null;
              }
              if (host.includes('uqload')) {
                const v = document.querySelector('video source, video');
                if (v) { const src = v.getAttribute('src') || v.src; if (src && src.startsWith('http')) return src; }
                const allText = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\\n');
                const m = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.mp4[^"'\`\\s]*/i);
                return (m && m[0]) || null;
              }
              if (host.includes('share4max')) {
                const v = document.querySelector('video source, video');
                if (v) { const src = v.getAttribute('src') || v.src; if (src && src.startsWith('http')) return src; }
                const allText = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\\n');
                const m1 = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.m3u8[^"'\`\\s]*/);
                const m2 = allText.match(/https?:\\/\\/[^"'\`\\s]+\\.mp4[^"'\`\\s]*/);
                return (m1 && m1[0]) || (m2 && m2[0]) || null;
              }
              const video = document.querySelector('video');
              if (video) {
                const src = video.getAttribute('src') || video.src;
                if (src && src.startsWith('http') && (src.includes('.mp4') || src.includes('.m3u8'))) return src;
                const source = video.querySelector('source');
                if (source) { const s = source.getAttribute('src') || source.src; if (s && s.startsWith('http')) return s; }
              }
              if (window.videojs) {
                try {
                  const players = Object.values(window.videojs.getPlayers() || {});
                  for (const p of players) {
                    const src = p.currentSrc && p.currentSrc();
                    if (src && src.startsWith('http') && (src.includes('.mp4') || src.includes('.m3u8'))) return src;
                  }
                } catch {}
              }
              if (window.jwplayer) {
                try {
                  const item = window.jwplayer().getPlaylistItem && window.jwplayer().getPlaylistItem();
                  if (item && item.file && item.file.startsWith('http')) return item.file;
                } catch {}
              }
              const scripts = [...document.querySelectorAll('script')].map(s => s.textContent || '').join('\\n');
              const r1 = scripts.match(/https?:\\/\\/[^"'\`\\s]+\\.m3u8[^"'\`\\s]*/);
              const r2 = scripts.match(/https?:\\/\\/[^"'\`\\s]+\\.mp4[^"'\`\\s]*/);
              return (r1 && r1[0]) || (r2 && r2[0]) || null;
            })()
          `);

          console.log('SCRAPED URL:', videoUrl);
          if (videoUrl) done(videoUrl);
        } catch (e) {
          console.error('scrape error:', e.message);
        }
      });

      const timer = setTimeout(() => { console.log('TIMEOUT - no video found'); done(null); }, 35000);

      win.loadURL(serverUrl, {
        userAgent: UA,
        httpReferrer: { url: 'https://w1.anime4up.rest/', policy: 'origin' },
        extraHeaders: `Origin: ${new URL(serverUrl).origin}\n`,
      });
    });
  });

  ipcMain.handle('fetch-page-full', async (event, url) => {
    return new Promise((resolve, reject) => {
      const hidden = new BrowserWindow({
        show: false, width: 1280, height: 900,
        webPreferences: { contextIsolation: false, nodeIntegration: false, webviewTag: false },
      });
      spoofHeaders(hidden.webContents.session);
      const timeout = setTimeout(async () => {
        try {
          const html = await hidden.webContents.executeJavaScript('document.documentElement.outerHTML');
          hidden.destroy(); resolve({ html });
        } catch { hidden.destroy(); reject(new Error('Timeout')); }
      }, 20000);
      hidden.webContents.on('did-finish-load', async () => {
        clearTimeout(timeout);
        try {
          await new Promise(r => setTimeout(r, 4000));
          await hidden.webContents.executeJavaScript(`
            (() => {
              const attrs = ['data-src','data-lazy-src','data-original','data-img','data-url','data-lazy'];
              document.querySelectorAll('img').forEach(img => {
                for (const attr of attrs) {
                  const val = img.getAttribute(attr);
                  if (val && val.startsWith('http')) { img.setAttribute('src', val); break; }
                }
              });
              window.dispatchEvent(new Event('scroll'));
              window.dispatchEvent(new Event('resize'));
            })()
          `);
          await new Promise(r => setTimeout(r, 1500));
          const html = await hidden.webContents.executeJavaScript('document.documentElement.outerHTML');
          hidden.destroy(); resolve({ html });
        } catch (e) { hidden.destroy(); reject(e); }
      });
      hidden.webContents.on('did-fail-load', (e, code, desc) => {
        clearTimeout(timeout); hidden.destroy(); reject(new Error(desc));
      });
      hidden.loadURL(url, {
        userAgent: UA,
        extraHeaders: 'Referer: https://w1.anime4up.rest/\nAccept-Language: ar,en;q=0.9\n',
      });
    });
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (proxyServer) proxyServer.close();
  if (process.platform !== 'darwin') app.quit();
});