const webview = document.getElementById('webview');
const urlDisplay = document.getElementById('current-url');
const homePanel = document.getElementById('home-panel');
const detailPanel = document.getElementById('detail-panel');
const playerArea = document.getElementById('player-area');
const animeGrid = document.getElementById('anime-grid');
const BASE = 'https://w1.anime4up.rest';

let currentDPlayer = null;
let currentSection = 'anime4up';
let gofileHistory = [];
let githubFileList = null;

function switchSection(section) {
  currentSection = section;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`btn-${section}`)?.classList.add('active');
  const searchInput = document.getElementById('search-input');
  if (section === 'anime4up') {
    searchInput.placeholder = '🔍 ابحث عن أنمي...';
    showHome();
    loadAllSections();
  } else {
    searchInput.placeholder = '🔍 ابحث في 4K Anime...';
    showHome();
    load4kAnime();
  }
}

function proxyUrl(url) {
  if (!url) return '';
  const full = url.startsWith('http') ? url : BASE + url;
  return `anime4up://image?url=${encodeURIComponent(full)}`;
}

function showHome() { homePanel.style.display = 'flex'; detailPanel.style.display = 'none'; playerArea.style.display = 'none'; }
function showDetail() { homePanel.style.display = 'none'; detailPanel.style.display = 'flex'; playerArea.style.display = 'none'; }
function showPlayer(url) { homePanel.style.display = 'none'; detailPanel.style.display = 'none'; playerArea.style.display = 'flex'; webview.src = url; }
function loadCustomUrl() { let url = document.getElementById('custom-url').value.trim(); if (!url.startsWith('http')) url = 'https://' + url; showPlayer(url); }
function goBack() { if (webview.canGoBack()) webview.goBack(); }
function goForward() { if (webview.canGoForward()) webview.goForward(); }
function reloadPage() { webview.reload(); }
webview.addEventListener('did-navigate', e => { urlDisplay.textContent = e.url; });
webview.addEventListener('did-navigate-in-page', e => { urlDisplay.textContent = e.url; });

function cleanFileName(name) {
  return name
    .replace(/[-_\s]+links?$/gi, '')
    .replace(/[-_\s]+episodes?$/gi, '')
    .replace(/[-_\s]+gofile$/gi, '')
    .replace(/[-_\s]+4k$/gi, '')
    .replace(/[-_\s]+hd$/gi, '')
    .replace(/[-_\s]+urls?$/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[-_\.]+$/, '')
    .replace(/^[-_\.]+/, '')
    .trim();
}

function normalizeName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ةه]/g, 'ه')
    .replace(/[يىئ]/g, 'ي')
    .replace(/[وؤ]/g, 'و')
    .replace(/\b(season|الموسم|part|cour|ova|ona|movie|فيلم|الجزء|حلقة|special)\b/gi, '')
    .replace(/\b(the|a|an|of|في|من|على|و|بـ)\b/gi, '')
    .replace(/\d{4}/g, '')
    .replace(/s\d+|ep?\d+/gi, '')
    .replace(/[^\w\u0600-\u06FF\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenScore(a, b) {
  const wa = normalizeName(a).split(' ').filter(w => w.length > 1);
  const wb = normalizeName(b).split(' ').filter(w => w.length > 1);
  if (!wa.length || !wb.length) return 0;
  let matches = 0;
  for (const w of wa) {
    if (wb.some(fw => fw === w || fw.includes(w) || w.includes(fw))) matches++;
  }
  return (matches / Math.max(wa.length, wb.length)) * 100;
}

function fuzzyMatch(candidates, fileList) {
  let bestScore = 0;
  let bestFile = null;
  for (const file of fileList) {
    const cleanedFileName = cleanFileName(file.name);
    for (const candidate of candidates) {
      const na = normalizeName(candidate);
      const nb = normalizeName(cleanedFileName);
      if (!na || !nb) continue;
      if (na === nb && na.length > 2) return { file, score: 100 };
      if ((na.includes(nb) || nb.includes(na)) && Math.min(na.length, nb.length) > 3) {
        const score = 85 + (Math.min(na.length, nb.length) / Math.max(na.length, nb.length)) * 14;
        if (score > bestScore) { bestScore = score; bestFile = file; }
        continue;
      }
      const score = tokenScore(candidate, cleanedFileName);
      if (score > bestScore) { bestScore = score; bestFile = file; }
    }
  }
  return bestScore >= 45 ? { file: bestFile, score: Math.round(bestScore) } : null;
}

async function checkGofileAvailability(animeTitle) {
  try {
    if (githubFileList === null) {
      const res = await window.electronAPI.fetchGithubFilelist();
      if (!res || res.error || !Array.isArray(res)) return null;
      githubFileList = res;
    }
    const anilistTitles = await window.electronAPI.fetchAnilistTitles(animeTitle);
    return fuzzyMatch([animeTitle, ...anilistTitles], githubFileList);
  } catch {
    return null;
  }
}

async function loadServer(url, btn) {
  document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const wrap = document.getElementById('player-wrap');
  if (!wrap) return;

  if (currentDPlayer) {
    try { currentDPlayer.destroy(); } catch {}
    currentDPlayer = null;
  }

  wrap.innerHTML = `
    <div id="dplayer-container"></div>
    <div id="player-loading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);color:#fff;font-size:15px;z-index:10;border-radius:8px;">⏳ جاري استخراج رابط الفيديو...</div>`;

  if (!url || !url.startsWith('http')) {
    const loading = document.getElementById('player-loading');
    if (loading) loading.textContent = '❌ رابط السيرفر غير صالح';
    return;
  }

  const videoUrl = await window.electronAPI.extractVideoUrl(url);
  const loading = document.getElementById('player-loading');

  if (!videoUrl) {
    if (loading) loading.textContent = '❌ تعذر استخراج رابط الفيديو، جرب سيرفراً آخر';
    return;
  }

  if (loading) loading.textContent = '⏳ جاري تحميل الفيديو...';

  const proxiedUrl = await window.electronAPI.proxyVideo(videoUrl);
  const playableUrl = proxiedUrl || videoUrl;

  if (!playableUrl) {
    if (loading) loading.textContent = '❌ فشل تحميل الفيديو، جرب سيرفراً آخر';
    return;
  }

  if (loading) loading.remove();

  currentDPlayer = new DPlayer({
    container: document.getElementById('dplayer-container'),
    autoplay: true,
    theme: '#029dbc',
    lang: 'ar',
    video: {
      url: playableUrl,
      type: videoUrl.includes('.m3u8') ? 'hls' : 'auto',
      customType: {
        hls: (video) => {
          const hls = new Hls();
          hls.loadSource(video.src);
          hls.attachMedia(video);
        },
      },
    },
  });
}

function extractCardsFrom(container) {
  const selectors = [
    '.anime-card-poster', '.pinned-card', '.anime-card-container',
    '.anime-card', '.page-card', '.episodes-card', 'article.post',
  ];

  const badTokens = ['placeholder', 'blank', 'spinner', 'loading', 'default', 'noimage', 'no-img'];
  const isBadImg = (u) => {
    if (!u) return true;
    const s = String(u).toLowerCase();
    if (s.startsWith('data:image/gif') || s.startsWith('data:')) return true;
    return badTokens.some(t => s.includes(t));
  };

  const toAbs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return BASE + u;
    return u;
  };

  const pickBestImg = (card, aEl, imgEl) => {
    const candidates = [
      imgEl?.getAttribute('data-src'),
      imgEl?.getAttribute('data-lazy-src'),
      imgEl?.getAttribute('data-lazy'),
      imgEl?.getAttribute('data-original'),
      imgEl?.getAttribute('data-image'),
      imgEl?.getAttribute('data-url'),
      imgEl?.getAttribute('data-img'),
      aEl?.getAttribute('data-src'),
      aEl?.getAttribute('data-lazy-src'),
      aEl?.getAttribute('data-lazy'),
      imgEl?.getAttribute('src'),
    ].filter(Boolean);

    for (const c of candidates) {
      const u = toAbs(c);
      if (/^https?:\/\//i.test(u) && !isBadImg(u)) return u;
    }

    const styleNodes = [card, ...card.querySelectorAll('[style*="background"], [style*="background-image"]')];
    for (const node of styleNodes) {
      const style = node.getAttribute?.('style') || '';
      const m = style.match(/url\(['"]?([^'")]+)['"]?\)/i);
      if (m) {
        const u = toAbs(m[1]);
        if (/^https?:\/\//i.test(u) && !isBadImg(u)) return u;
      }
    }

    return '';
  };

  for (const sel of selectors) {
    const nodes = [...container.querySelectorAll(sel)];
    if (!nodes.length) continue;

    const items = nodes.map(card => {
      const aEl = card.querySelector('a');
      const imgEl = card.querySelector('img');

      const title =
        card.querySelector('.anime-card-title h3')?.textContent?.trim() ||
        card.querySelector('.anime-card-title')?.textContent?.trim() ||
        card.querySelector('h3')?.textContent?.trim() ||
        aEl?.getAttribute('title') ||
        imgEl?.getAttribute('alt') ||
        '';

      const img = pickBestImg(card, aEl, imgEl);
      const link = aEl?.getAttribute('href') || '';
      const ep = card.querySelector('.badge,[class*="ep-num"],[class*="ep-title"]')?.textContent?.trim() || '';
      const type = card.querySelector('.anime-type-badge,.anime-card-type,[class*="type"],.badge')?.textContent?.trim() || '';
      return { title, img, link, ep, type };
    }).filter(i => i.link && (i.title || i.img));

    if (items.length) return items;
  }

  return [];
}

function renderSection(heading, items, container) {
  if (!items.length) return;

  const sec = document.createElement('div');
  sec.className = 'home-section';

  if (heading) {
    const h2 = document.createElement('h2');
    h2.className = 'section-heading';
    h2.textContent = heading;
    sec.appendChild(h2);
  }

  const row = document.createElement('div');
  row.className = 'section-row';

  items.forEach(({ title, img, link, ep, type }) => {
    const href = link.startsWith('http') ? link : BASE + link;
    const card = document.createElement('div');
    card.className = 'anime-card';
    card.style.cursor = 'pointer';

    if (type) {
      const typeSpan = document.createElement('span');
      typeSpan.className = 'card-type';
      typeSpan.textContent = type;
      card.appendChild(typeSpan);
    }

    if (img) {
      const imgEl = document.createElement('img');
      imgEl.src = proxyUrl(img);
      imgEl.alt = title || 'image';
      imgEl.onerror = () => {
        imgEl.remove();
        const fallback = document.createElement('div');
        fallback.style.cssText = 'width:100%;aspect-ratio:3/4;background:#111;display:flex;align-items:center;justify-content:center;color:#666;font-size:14px;';
        fallback.textContent = 'No Image';
        card.insertBefore(fallback, card.querySelector('.card-info'));
      };
      card.appendChild(imgEl);
    } else {
      const fallback = document.createElement('div');
      fallback.style.cssText = 'width:100%;aspect-ratio:3/4;background:#111;display:flex;align-items:center;justify-content:center;color:#666;font-size:14px;';
      fallback.textContent = 'No Image';
      card.appendChild(fallback);
    }

    const info = document.createElement('div');
    info.className = 'card-info';

    const titleSpan = document.createElement('span');
    titleSpan.className = 'card-title';
    titleSpan.textContent = title;
    info.appendChild(titleSpan);

    if (ep) {
      const epSpan = document.createElement('span');
      epSpan.className = 'card-ep';
      epSpan.textContent = ep;
      info.appendChild(epSpan);
    }

    card.appendChild(info);
    card.addEventListener('click', () => openAnimeDetail(href));
    row.appendChild(card);
  });

  sec.appendChild(row);
  container.appendChild(sec);
}

function extractFromHome(homeDoc, keyword) {
  const heading = [...homeDoc.querySelectorAll('h2,h3,h4,.section-title,[class*="section-head"]')]
    .find(h => h.textContent.trim().includes(keyword));
  if (!heading) return [];
  let items = [], wrapper = heading.parentElement;
  for (let i = 0; i < 8; i++) {
    if (!wrapper || wrapper === homeDoc.body) break;
    items = extractCardsFrom(wrapper);
    if (items.length) break;
    wrapper = wrapper.parentElement;
  }
  if (!items.length) {
    let sib = heading.nextElementSibling;
    for (let i = 0; i < 6 && sib; i++) {
      items = extractCardsFrom(sib);
      if (items.length) break;
      sib = sib.nextElementSibling;
    }
  }
  return items;
}

async function loadAllSections() {
  showHome();
  animeGrid.innerHTML = '<div class="loading">⏳ جاري تحميل الصفحة...</div>';
  try {
    const html = await window.electronAPI.fetchPage(BASE + '/home8/');
    const homeDoc = new DOMParser().parseFromString(html, 'text/html');
    animeGrid.innerHTML = '';
    const sections = [
      { keyword: 'المثبتة', label: 'الأنميات المثبتة' },
      { keyword: 'الحلقات', label: 'أخر الحلقات المضافة' },
      { keyword: 'أحدث أنميات', label: 'أحدث أنميات موسم ربيع 2026' },
      { keyword: 'أكثر أنميات', label: 'أكثر أنميات هذا الموسم مشاهدة' },
      { keyword: 'أكثر الأنميات', label: 'أكثر الأنميات مشاهدة' },
    ];
    const seenLinks = new Set();
    for (const { keyword, label } of sections) {
      const items = extractFromHome(homeDoc, keyword).filter(i => !seenLinks.has(i.link));
      items.forEach(i => seenLinks.add(i.link));
      if (items.length) renderSection(label, items, animeGrid);
    }
    if (!animeGrid.children.length) {
      const allItems = extractCardsFrom(homeDoc.body);
      if (allItems.length) renderSection('', allItems, animeGrid);
      else animeGrid.innerHTML = '<div class="loading">😕 لم يتم العثور على محتوى.</div>';
    }
  } catch (e) {
    animeGrid.innerHTML = `<div class="loading">❌ خطأ: ${e.message}</div>`;
  }
}

async function searchAnime() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;

  if (currentSection === '4kanime') {
    showHome();
    animeGrid.innerHTML = '<div class="loading" style="padding:60px;text-align:center;color:#666;">🔍 البحث في 4K Anime غير متاح بعد</div>';
    return;
  }

  showHome();
  animeGrid.innerHTML = '<div class="loading">🔍 جاري البحث...</div>';
  try {
    const html = await window.electronAPI.fetchPage(`${BASE}/?search_param=animes&s=${encodeURIComponent(q)}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    animeGrid.innerHTML = '';
    const items = extractCardsFrom(doc.body);
    renderSection(`نتائج البحث: "${q}"`, items, animeGrid);
    if (!items.length) animeGrid.innerHTML = '<div class="loading">😕 لا توجد نتائج.</div>';
  } catch (e) {
    animeGrid.innerHTML = `<div class="loading">❌ خطأ: ${e.message}</div>`;
  }
}

async function openEpisodePage(url) {
  showDetail();
  document.getElementById('detail-inner').innerHTML = '<div class="loading" style="padding:60px;text-align:center">⏳ جاري تحميل الحلقة...</div>';
  try {
    const html = await window.electronAPI.fetchPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('.main-section h3, h1')?.textContent?.trim() || 'الحلقة';

    const servers = [...doc.querySelectorAll('#episode-servers li')]
      .filter(li => li.getAttribute('data-watch'))
      .map(li => ({
        label: li.querySelector('a')?.textContent?.trim() || li.textContent?.trim() || 'سيرفر',
        watch: li.getAttribute('data-watch'),
      }));

    const epLinks = [...doc.querySelectorAll('#ULEpisodesList li a')].map(a => ({
      label: a.textContent.trim(),
      href: a.getAttribute('href'),
    }));

    const animeLink = doc.querySelector('a[href*="/anime/"]')?.getAttribute('href') || '';
    const animeUrl = animeLink ? (animeLink.startsWith('http') ? animeLink : BASE + animeLink) : null;

    const inner = document.getElementById('detail-inner');
    inner.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'episode-page';

    const navBtns = document.createElement('div');
    navBtns.className = 'ep-nav-btns';

    const homeBtn = document.createElement('button');
    homeBtn.className = 'back-btn';
    homeBtn.textContent = '🏠 الرئيسية';
    homeBtn.addEventListener('click', () => showHome());
    navBtns.appendChild(homeBtn);

    if (animeUrl) {
      const animeBtn = document.createElement('button');
      animeBtn.className = 'back-btn';
      animeBtn.textContent = '← صفحة الأنمي';
      animeBtn.addEventListener('click', () => openAnimeDetail(animeUrl));
      navBtns.appendChild(animeBtn);
    }

    wrapper.appendChild(navBtns);

    const titleEl = document.createElement('h2');
    titleEl.className = 'ep-page-title';
    titleEl.textContent = title;
    wrapper.appendChild(titleEl);

    const playerWrap = document.createElement('div');
    playerWrap.className = 'inline-player-wrap';
    playerWrap.id = 'player-wrap';
    playerWrap.style.position = 'relative';

    const placeholder = document.createElement('div');
    placeholder.id = 'player-placeholder';
    placeholder.style.cssText = 'width:100%;aspect-ratio:16/9;background:#111;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#666;font-size:16px;';
    placeholder.textContent = '🎬 اختر سيرفراً للمشاهدة';
    playerWrap.appendChild(placeholder);
    wrapper.appendChild(playerWrap);

    if (servers.length) {
      const serversSec = document.createElement('div');
      serversSec.className = 'servers-section';
      const serversTitle = document.createElement('h3');
      serversTitle.className = 'servers-title';
      serversTitle.textContent = '🎬 اختر السيرفر';
      serversSec.appendChild(serversTitle);

      const serversGrid = document.createElement('div');
      serversGrid.className = 'servers-grid';

      servers.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'server-btn';
        btn.textContent = s.label;
        btn.addEventListener('click', () => loadServer(s.watch, btn));
        serversGrid.appendChild(btn);
      });

      serversSec.appendChild(serversGrid);
      wrapper.appendChild(serversSec);
    } else {
      const noServers = document.createElement('div');
      noServers.className = 'loading';
      noServers.textContent = '😕 لم يتم العثور على سيرفرات.';
      wrapper.appendChild(noServers);
    }

    if (epLinks.length) {
      const sidebar = document.createElement('div');
      sidebar.className = 'ep-sidebar';
      const sideTitle = document.createElement('h3');
      sideTitle.className = 'ep-sidebar-title';
      sideTitle.textContent = '📋 قائمة الحلقات';
      sidebar.appendChild(sideTitle);

      const ul = document.createElement('ul');
      ul.className = 'ep-sidebar-list';

      epLinks.forEach(e => {
        const href = e.href?.startsWith('http') ? e.href : BASE + e.href;
        const li = document.createElement('li');
        li.textContent = e.label;
        li.addEventListener('click', () => openEpisodePage(href));
        ul.appendChild(li);
      });

      sidebar.appendChild(ul);
      wrapper.appendChild(sidebar);
    }

    inner.appendChild(wrapper);
  } catch (e) {
    document.getElementById('detail-inner').innerHTML = `<div class="loading">❌ خطأ: ${e.message}</div>`;
  }
}

async function openAnimeDetail(url) {
  if (url.includes('/episode/')) return openEpisodePage(url);
  showDetail();
  document.getElementById('detail-inner').innerHTML = '<div class="loading" style="padding:60px;text-align:center">⏳ جاري تحميل التفاصيل...</div>';
  try {
    const html = await window.electronAPI.fetchPage(url);
    await renderDetailPage(html, url);
  } catch (e) {
    document.getElementById('detail-inner').innerHTML = `<div class="loading">❌ خطأ: ${e.message}</div>`;
  }
}

async function renderDetailPage(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (pageUrl.includes('/episode/')) {
    const animeLink =
      doc.querySelector('.breadcrumb a[href*="/anime/"]')?.getAttribute('href') ||
      doc.querySelector('a[href*="/anime/"]')?.getAttribute('href') || '';
    if (animeLink) {
      const animeUrl = animeLink.startsWith('http') ? animeLink : BASE + animeLink;
      try {
        const animeHtml = await window.electronAPI.fetchPage(animeUrl);
        return renderDetailPage(animeHtml, animeUrl);
      } catch {}
    }
  }

  const title = doc.querySelector('.anime-title, h1.title, h1')?.textContent?.trim() || 'بدون عنوان';
  const posterEl = doc.querySelector('.thumbnail.img-responsive, .anime-poster img, .poster img, .cover img, img[class*="poster"]');
  const posterUrl =
    posterEl?.getAttribute('data-src') ||
    posterEl?.getAttribute('data-lazy-src') ||
    posterEl?.getAttribute('data-lazy') ||
    posterEl?.getAttribute('data-image') ||
    posterEl?.getAttribute('src') ||
    '';

  const desc = doc.querySelector('.anime-story, .story, [class*="story"], [class*="description"]')?.textContent?.trim() || '';
  const genres = [...doc.querySelectorAll('.anime-genres a, .genres a, [class*="genre"] a, .tags a')].map(a => a.textContent.trim()).filter(Boolean);

  const infoRows = {};
  doc.querySelectorAll('.anime-info li, .info-list li, table tr').forEach(row => {
    const text = row.textContent.trim();
    if (text.includes(':')) {
      const [k, ...v] = text.split(':');
      infoRows[k.trim()] = v.join(':').trim();
    }
  });

  const episodes = [];
  doc.querySelectorAll('#episodesList .pinned-card').forEach(card => {
    const aEl = card.querySelector('a');
    const epLink = aEl?.getAttribute('href') || '';
    const epImg =
      aEl?.getAttribute('data-src') ||
      aEl?.getAttribute('data-lazy-src') ||
      aEl?.getAttribute('data-lazy') || '';
    const epTitle =
      card.querySelector('h3')?.textContent?.trim() ||
      card.querySelector('.info a')?.textContent?.trim() ||
      aEl?.getAttribute('title') || '';
    const epNum = card.querySelector('.badge')?.textContent?.trim() || '';
    if (epLink) episodes.push({ epTitle, epLink, epImg, epNum });
  });

  const inner = document.getElementById('detail-inner');
  inner.innerHTML = '';

  const hero = document.createElement('div');
  hero.className = 'detail-hero';

  const backBtn = document.createElement('button');
  backBtn.className = 'back-btn';
  backBtn.textContent = '← رجوع';
  backBtn.addEventListener('click', () => showHome());
  hero.appendChild(backBtn);

  const detailTop = document.createElement('div');
  detailTop.className = 'detail-top';

  const poster = document.createElement('img');
  poster.src = proxyUrl(posterUrl);
  poster.alt = title;
  poster.className = 'detail-poster';
  poster.onerror = () => { poster.remove(); };
  detailTop.appendChild(poster);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';

  const titleNode = document.createElement('h1');
  titleNode.className = 'detail-title';
  titleNode.textContent = title;
  meta.appendChild(titleNode);

  if (genres.length) {
    const genreRow = document.createElement('div');
    genreRow.className = 'genres-row';
    genres.forEach(g => {
      const span = document.createElement('span');
      span.className = 'genre-tag';
      span.textContent = g;
      genreRow.appendChild(span);
    });
    meta.appendChild(genreRow);
  }

  if (desc) {
    const descP = document.createElement('p');
    descP.className = 'detail-desc';
    descP.textContent = desc;
    meta.appendChild(descP);
  }

  if (Object.keys(infoRows).length) {
    const infoGrid = document.createElement('div');
    infoGrid.className = 'info-grid';
    Object.entries(infoRows).forEach(([k, v]) => {
      const row = document.createElement('div');
      row.className = 'info-row';
      row.innerHTML = `<span class="info-key">${k}</span><span class="info-val">${v}</span>`;
      infoGrid.appendChild(row);
    });
    meta.appendChild(infoGrid);
  }

  const watchBtn = document.createElement('button');
  watchBtn.className = 'watch-btn';
  watchBtn.textContent = '▶ مشاهدة وتحميل الآن';
  watchBtn.addEventListener('click', () => showPlayer(pageUrl));
  meta.appendChild(watchBtn);

  detailTop.appendChild(meta);
  hero.appendChild(detailTop);
  inner.appendChild(hero);

  const bannerSlot = document.createElement('div');
  bannerSlot.id = 'gofile-banner-slot';
  inner.appendChild(bannerSlot);

  if (episodes.length) {
    const epSection = document.createElement('div');
    epSection.className = 'episodes-section';
    const epHeading = document.createElement('h2');
    epHeading.className = 'ep-heading';
    epHeading.textContent = `📺 الحلقات (${episodes.length})`;
    epSection.appendChild(epHeading);

    const epGrid = document.createElement('div');
    epGrid.className = 'episodes-grid';

    episodes.forEach(({ epTitle, epLink, epImg, epNum }) => {
      const href = epLink.startsWith('http') ? epLink : BASE + epLink;
      const card = document.createElement('div');
      card.className = 'ep-card';
      card.style.cursor = 'pointer';

      if (epImg) {
        const img = document.createElement('img');
        img.src = proxyUrl(epImg);
        img.style.cssText = 'width:100%;aspect-ratio:16/9;object-fit:cover;display:block;';
        img.onerror = () => { img.remove(); };
        card.appendChild(img);
      }

      const epInfo = document.createElement('div');
      epInfo.className = 'ep-info';

      const epTitleEl = document.createElement('span');
      epTitleEl.className = 'ep-title';
      epTitleEl.textContent = epTitle;
      epInfo.appendChild(epTitleEl);

      if (epNum) {
        const epNumEl = document.createElement('span');
        epNumEl.className = 'ep-num';
        epNumEl.textContent = epNum;
        epInfo.appendChild(epNumEl);
      }

      card.appendChild(epInfo);
      card.addEventListener('click', () => openEpisodePage(href));
      epGrid.appendChild(card);
    });

    epSection.appendChild(epGrid);
    inner.appendChild(epSection);
  }

  checkGofileAvailability(title).then(match => {
    const slot = document.getElementById('gofile-banner-slot');
    if (!slot) return;
    if (!match) { slot.innerHTML = ''; return; }
    const displayName = cleanFileName(match.file.name);

    const banner = document.createElement('div');
    banner.style.cssText = 'background:linear-gradient(135deg,#1a2a1a,#0d1f0d);border:1px solid #2ecc71;border-radius:12px;padding:18px 22px;margin:16px 0;display:flex;align-items:center;gap:16px;flex-wrap:wrap;';

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:200px;';
    info.innerHTML = `<div style="font-size:16px;font-weight:bold;color:#2ecc71;margin-bottom:4px;">🎬 متوفر بجودة 4K على Gofile</div><div style="font-size:13px;color:#888;">تم العثور على مطابقة: <strong style="color:#ccc;">${displayName}</strong></div>`;
    banner.appendChild(info);

    const btn = document.createElement('button');
    btn.textContent = '📂 عرض الحلقات 4K';
    btn.style.cssText = 'padding:10px 22px;border-radius:8px;background:#2ecc71;color:#000;font-weight:bold;border:none;cursor:pointer;font-size:14px;white-space:nowrap;';
    btn.addEventListener('click', () => loadGofileEpisodeList(match.file.download_url, displayName));
    banner.appendChild(btn);

    slot.innerHTML = '';
    slot.appendChild(banner);
  });
}

async function loadGofileEpisodeList(downloadUrl, animeName) {
  const slot = document.getElementById('gofile-banner-slot');
  if (slot) {
    slot.innerHTML = '';
    const loading = document.createElement('div');
    loading.style.cssText = 'padding:16px;color:#aaa;font-size:14px;';
    loading.textContent = '⏳ جاري تحميل قائمة الحلقات...';
    slot.appendChild(loading);
  }

  const lines = await window.electronAPI.fetchGithubFile(downloadUrl);

  if (!lines || lines.error || !lines.length) {
    if (slot) {
      slot.innerHTML = '';
      const err = document.createElement('div');
      err.style.cssText = 'padding:16px;color:#e74c3c;';
      err.textContent = '❌ تعذر تحميل الحلقات';
      slot.appendChild(err);
    }
    return;
  }

  const episodes = lines.map((url, i) => {
    const filename = decodeURIComponent(url.split('/').pop());
    return { label: `الحلقة ${i + 1}`, directUrl: url, filename };
  });

  if (!slot) return;

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'background:linear-gradient(135deg,#1a2a1a,#0d1f0d);border:1px solid #2ecc71;border-radius:12px;padding:18px 22px;margin:16px 0;';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:16px;font-weight:bold;color:#2ecc71;margin-bottom:12px;';
  heading.textContent = `🎬 حلقات 4K — ${animeName}`;

  const countSpan = document.createElement('span');
  countSpan.style.cssText = 'font-size:12px;color:#666;margin-right:8px;';
  countSpan.textContent = ` (${episodes.length} حلقة)`;
  heading.appendChild(countSpan);

  wrapper.appendChild(heading);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';

  episodes.forEach(ep => {
    const btn = document.createElement('button');
    btn.textContent = `▶ ${ep.label}`;
    btn.style.cssText = 'padding:8px 14px;border-radius:6px;background:#1a1a2e;color:#fff;border:1px solid #333;cursor:pointer;font-size:13px;transition:all 0.2s;';
    btn.addEventListener('mouseover', () => { btn.style.borderColor = '#2ecc71'; btn.style.color = '#2ecc71'; });
    btn.addEventListener('mouseout', () => { btn.style.borderColor = '#333'; btn.style.color = '#fff'; });
    btn.addEventListener('click', () => playDirectMkv(ep.directUrl, ep.filename));
    btnRow.appendChild(btn);
  });

  wrapper.appendChild(btnRow);
  slot.innerHTML = '';
  slot.appendChild(wrapper);
}

async function playDirectMkv(directUrl, filename) {
  showDetail();

  const inner = document.getElementById('detail-inner');
  inner.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'episode-page';

  const navBtns = document.createElement('div');
  navBtns.className = 'ep-nav-btns';

  const backBtn = document.createElement('button');
  backBtn.className = 'back-btn';
  backBtn.textContent = '← رجوع';
  backBtn.addEventListener('click', () => history.back());
  navBtns.appendChild(backBtn);
  page.appendChild(navBtns);

  const titleEl = document.createElement('h2');
  titleEl.className = 'ep-page-title';
  titleEl.style.wordBreak = 'break-all';
  titleEl.textContent = filename;
  page.appendChild(titleEl);

  const wrap = document.createElement('div');
  wrap.className = 'inline-player-wrap';
  wrap.id = 'player-wrap';
  wrap.style.position = 'relative';

  const loadingDiv = document.createElement('div');
  loadingDiv.style.cssText = 'width:100%;aspect-ratio:16/9;background:#111;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;';
  loadingDiv.textContent = '⏳ جاري تحميل الفيديو...';
  wrap.appendChild(loadingDiv);
  page.appendChild(wrap);
  inner.appendChild(page);

  let proxiedUrl = null;
  try {
    proxiedUrl = await window.electronAPI.proxyVideo(directUrl);
  } catch {}

  const name = (filename || '').toLowerCase();
  const isMkv = name.endsWith('.mkv');
  const isWebm = name.endsWith('.webm');
  const isM3u8 = name.endsWith('.m3u8') || (directUrl || '').includes('.m3u8');
  const playableUrl = proxiedUrl || directUrl;

  if (!playableUrl) {
    loadingDiv.textContent = '❌ فشل تحميل الفيديو';
    return;
  }

  wrap.innerHTML = '';

  if (isMkv || isWebm) {
    const videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.style.cssText = 'width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;outline:none;';
    videoEl.src = playableUrl;
    videoEl.innerHTML = 'متصفحك لا يدعم تشغيل هذا الفيديو.';
    wrap.appendChild(videoEl);
    return;
  }

  const container = document.createElement('div');
  container.id = 'dplayer-container';
  wrap.appendChild(container);

  if (currentDPlayer) {
    try { currentDPlayer.destroy(); } catch {}
    currentDPlayer = null;
  }

  currentDPlayer = new DPlayer({
    container,
    autoplay: true,
    theme: '#f5a623',
    lang: 'ar',
    video: {
      url: playableUrl,
      type: isM3u8 ? 'hls' : 'auto',
      customType: {
        hls: (videoEl) => {
          const hls = new Hls();
          hls.loadSource(videoEl.src);
          hls.attachMedia(videoEl);
        },
      },
    },
  });
}

function parseGofileId(input) {
  input = input.trim();
  const match = input.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9]{4,}$/.test(input)) return input;
  return null;
}

async function load4kAnime() {
  gofileHistory = [];
  showHome();
  animeGrid.innerHTML = '';

  const bar = document.createElement('div');
  bar.id = 'gofile-url-bar';
  bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:14px 4px;margin-bottom:10px;';

  const input = document.createElement('input');
  input.id = 'gofile-input';
  input.type = 'text';
  input.placeholder = 'أدخل رابط Gofile أو ID  —  مثال: https://gofile.io/d/bpgdD2';
  input.style.cssText = 'flex:1;padding:10px 14px;border-radius:8px;border:1px solid #333;background:#111;color:#fff;font-size:14px;outline:none;';
  input.addEventListener('keydown', e => { if (e.key === 'Enter') loadGofileFromInput(); });

  const goBtn = document.createElement('button');
  goBtn.textContent = '📂 تحميل';
  goBtn.style.cssText = 'padding:10px 18px;border-radius:8px;background:#f5a623;color:#000;font-weight:bold;border:none;cursor:pointer;font-size:14px;white-space:nowrap;';
  goBtn.addEventListener('click', () => loadGofileFromInput());

  bar.appendChild(input);
  bar.appendChild(goBtn);
  animeGrid.appendChild(bar);

  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading';
  loadingEl.style.cssText = 'padding:30px;text-align:center;';
  loadingEl.textContent = '⏳ جاري تحميل القائمة من GitHub...';
  animeGrid.appendChild(loadingEl);

  const list = await window.electronAPI.loadGofileList();
  loadingEl.remove();

  if (list?.error) {
    const errEl = document.createElement('div');
    errEl.className = 'loading';
    errEl.style.color = '#e74c3c';
    errEl.textContent = `❌ ${list.error}`;
    animeGrid.appendChild(errEl);
    return;
  }

  if (!list?.length) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'loading';
    emptyEl.style.color = '#666';
    emptyEl.textContent = '📭 لا توجد أنميات في المستودع بعد';
    animeGrid.appendChild(emptyEl);
    return;
  }

  githubFileList = list;

  const sec = document.createElement('div');
  sec.className = 'home-section';
  const secHeading = document.createElement('h2');
  secHeading.className = 'section-heading';
  secHeading.textContent = `🎥 أنميات 4K (${list.length})`;
  sec.appendChild(secHeading);

  const row = document.createElement('div');
  row.className = 'section-row';

  list.forEach(anime => {
    const displayName = cleanFileName(anime.name);
    const card = document.createElement('div');
    card.className = 'anime-card';
    card.style.cursor = 'pointer';

    const icon = document.createElement('div');
    icon.style.cssText = 'width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;font-size:48px;background:#111;';
    icon.textContent = '🎬';
    card.appendChild(icon);

    const cardInfo = document.createElement('div');
    cardInfo.className = 'card-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'card-title';
    nameSpan.textContent = displayName;
    cardInfo.appendChild(nameSpan);

    card.appendChild(cardInfo);
    card.addEventListener('click', () => openAnimeEpisodeListFromGithub(anime));
    row.appendChild(card);
  });

  sec.appendChild(row);
  animeGrid.appendChild(sec);
}

async function loadGofileFromInput() {
  const inputEl = document.getElementById('gofile-input');
  if (!inputEl) return;
  const id = parseGofileId(inputEl.value);
  if (!id) {
    inputEl.style.borderColor = '#e74c3c';
    inputEl.placeholder = '❌ رابط غير صالح — أدخل رابط gofile.io أو ID';
    inputEl.value = '';
    return;
  }
  inputEl.style.borderColor = '#2ecc71';
  gofileHistory = [];
  await openGofileFolder(id, `📂 ${id}`, true);
}

async function openAnimeEpisodeListFromGithub(anime) {
  showDetail();
  const inner = document.getElementById('detail-inner');
  const displayName = cleanFileName(anime.name);

  inner.innerHTML = '';

  const hero = document.createElement('div');
  hero.className = 'detail-hero';

  const backBtn = document.createElement('button');
  backBtn.className = 'back-btn';
  backBtn.textContent = '← رجوع';
  backBtn.addEventListener('click', () => load4kAnime());
  hero.appendChild(backBtn);

  const detailTop = document.createElement('div');
  detailTop.className = 'detail-top';

  const icon = document.createElement('div');
  icon.style.cssText = 'width:160px;min-width:160px;aspect-ratio:3/4;background:#111;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:64px;';
  icon.textContent = '🎬';
  detailTop.appendChild(icon);

  const meta = document.createElement('div');
  meta.className = 'detail-meta';

  const titleEl = document.createElement('h1');
  titleEl.className = 'detail-title';
  titleEl.textContent = displayName;
  meta.appendChild(titleEl);

  const statusP = document.createElement('p');
  statusP.style.cssText = 'color:#aaa;font-size:13px;';
  statusP.textContent = '⏳ جاري تحميل الحلقات...';
  meta.appendChild(statusP);

  detailTop.appendChild(meta);
  hero.appendChild(detailTop);
  inner.appendChild(hero);

  const slot = document.createElement('div');
  slot.id = 'ep-list-slot';
  inner.appendChild(slot);

  const lines = await window.electronAPI.fetchGithubFile(anime.download_url);

  if (!lines || lines.error || !lines.length) {
    statusP.textContent = '❌ تعذر تحميل الحلقات';
    statusP.style.color = '#e74c3c';
    return;
  }

  const episodes = lines.map((url, i) => {
    const filename = decodeURIComponent(url.split('/').pop());
    return { label: `الحلقة ${i + 1}`, directUrl: url, filename };
  });

  statusP.textContent = `${episodes.length} حلقة متاحة`;

  const section = document.createElement('div');
  section.className = 'episodes-section';
  const epHeading = document.createElement('h2');
  epHeading.className = 'ep-heading';
  epHeading.textContent = `📺 الحلقات (${episodes.length})`;
  section.appendChild(epHeading);

  const grid = document.createElement('div');
  grid.className = 'episodes-grid';

  episodes.forEach(ep => {
    const card = document.createElement('div');
    card.className = 'ep-card';
    card.style.cursor = 'pointer';

    const epInfo = document.createElement('div');
    epInfo.className = 'ep-info';
    epInfo.style.padding = '14px';

    const epTitle = document.createElement('span');
    epTitle.className = 'ep-title';
    epTitle.textContent = `▶ ${ep.label}`;
    epInfo.appendChild(epTitle);

    const epNum = document.createElement('span');
    epNum.className = 'ep-num';
    epNum.style.cssText = 'font-size:11px;color:#666;';
    epNum.textContent = ep.filename;
    epInfo.appendChild(epNum);

    card.appendChild(epInfo);
    card.addEventListener('click', () => playDirectMkv(ep.directUrl, ep.filename));
    grid.appendChild(card);
  });

  section.appendChild(grid);
  slot.appendChild(section);
}

async function openGofileFolder(contentId, folderName, keepBar = false) {
  showHome();

  [...animeGrid.children].forEach(child => {
    if (child.id !== 'gofile-url-bar') child.remove();
  });

  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading';
  loadingEl.style.cssText = 'padding:40px;text-align:center;';
  loadingEl.textContent = '⏳ جاري تحميل محتوى Gofile...';
  animeGrid.appendChild(loadingEl);

  const data = await window.electronAPI.fetchGofile(contentId);
  loadingEl.remove();

  if (data.error) {
    const errEl = document.createElement('div');
    errEl.className = 'loading';
    errEl.textContent = `❌ خطأ: ${data.error}`;
    animeGrid.appendChild(errEl);
    return;
  }

  if (gofileHistory.length > 0) {
    const prev = gofileHistory[gofileHistory.length - 1];
    const backBtn = document.createElement('button');
    backBtn.className = 'back-btn';
    backBtn.style.margin = '0 0 14px 0';
    backBtn.textContent = `← رجوع إلى ${prev.name}`;
    backBtn.addEventListener('click', () => {
      const target = gofileHistory.pop();
      if (target.isAnimeList) openAnimeEpisodeListFromGithub(target.anime);
      else if (target.isDetailBack) history.back();
      else openGofileFolder(target.id, target.name, false);
    });
    animeGrid.appendChild(backBtn);
  }

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = folderName || data.name;
  animeGrid.appendChild(heading);

  if (data.folders.length > 0) {
    const folderSec = document.createElement('div');
    folderSec.className = 'home-section';
    const fh = document.createElement('h3');
    fh.className = 'section-heading';
    fh.style.cssText = 'font-size:15px;color:#888;';
    fh.textContent = `📁 المجلدات (${data.folders.length})`;
    folderSec.appendChild(fh);

    const folderRow = document.createElement('div');
    folderRow.className = 'section-row';
    data.folders.forEach(f => {
      const card = document.createElement('div');
      card.className = 'anime-card';
      card.style.cursor = 'pointer';

      const icon = document.createElement('div');
      icon.style.cssText = 'width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;font-size:48px;background:#111;';
      icon.textContent = '📁';
      card.appendChild(icon);

      const info = document.createElement('div');
      info.className = 'card-info';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'card-title';
      nameSpan.textContent = f.name;
      info.appendChild(nameSpan);
      card.appendChild(info);

      card.addEventListener('click', () => {
        gofileHistory.push({ id: contentId, name: folderName });
        openGofileFolder(f.id, f.name, false);
      });

      folderRow.appendChild(card);
    });

    folderSec.appendChild(folderRow);
    animeGrid.appendChild(folderSec);
  }

  if (data.videos.length > 0) {
    const videoSec = document.createElement('div');
    videoSec.className = 'home-section';
    const vh = document.createElement('h3');
    vh.className = 'section-heading';
    vh.style.cssText = 'font-size:15px;color:#888;';
    vh.textContent = `🎬 الفيديوهات (${data.videos.length})`;
    videoSec.appendChild(vh);

    const videoRow = document.createElement('div');
    videoRow.className = 'section-row';
    data.videos.forEach(v => {
      const sizeMB = v.size ? (v.size / 1024 / 1024).toFixed(0) + ' MB' : '';
      const card = document.createElement('div');
      card.className = 'anime-card';
      card.style.cursor = 'pointer';

      const icon = document.createElement('div');
      icon.style.cssText = 'width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;font-size:48px;background:#111;';
      icon.textContent = '🎬';
      card.appendChild(icon);

      const info = document.createElement('div');
      info.className = 'card-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'card-title';
      nameSpan.textContent = v.name;
      info.appendChild(nameSpan);

      if (sizeMB) {
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'card-ep';
        sizeSpan.textContent = sizeMB;
        info.appendChild(sizeSpan);
      }

      card.appendChild(info);
      card.addEventListener('click', () => playGofileVideo(v));
      videoRow.appendChild(card);
    });

    videoSec.appendChild(videoRow);
    animeGrid.appendChild(videoSec);
  }

  if (data.folders.length === 0 && data.videos.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'loading';
    emptyEl.style.color = '#666';
    emptyEl.textContent = '📭 هذا المجلد فارغ';
    animeGrid.appendChild(emptyEl);
  }
}

async function playGofileVideo(video) {
  showDetail();
  const inner = document.getElementById('detail-inner');
  inner.innerHTML = '';

  const page = document.createElement('div');
  page.className = 'episode-page';

  const navBtns = document.createElement('div');
  navBtns.className = 'ep-nav-btns';
  const backBtn = document.createElement('button');
  backBtn.className = 'back-btn';
  backBtn.textContent = '← رجوع';
  backBtn.addEventListener('click', () => history.back());
  navBtns.appendChild(backBtn);
  page.appendChild(navBtns);

  const titleEl = document.createElement('h2');
  titleEl.className = 'ep-page-title';
  titleEl.style.wordBreak = 'break-all';
  titleEl.textContent = video.name;
  page.appendChild(titleEl);

  const wrap = document.createElement('div');
  wrap.className = 'inline-player-wrap';
  wrap.id = 'player-wrap';
  wrap.style.position = 'relative';

  const loadingDiv = document.createElement('div');
  loadingDiv.style.cssText = 'width:100%;aspect-ratio:16/9;background:#111;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;';
  loadingDiv.textContent = '⏳ جاري تحميل الفيديو...';
  wrap.appendChild(loadingDiv);
  page.appendChild(wrap);
  inner.appendChild(page);

  let proxiedUrl = null;
  try {
    proxiedUrl = await window.electronAPI.proxyVideo(video.link);
  } catch {}

  const name = (video.name || '').toLowerCase();
  const isMkv = name.endsWith('.mkv');
  const isWebm = name.endsWith('.webm');
  const isM3u8 = name.endsWith('.m3u8') || (video.link || '').includes('.m3u8');
  const playableUrl = proxiedUrl || video.link;

  if (!playableUrl) {
    loadingDiv.textContent = '❌ فشل تحميل الفيديو';
    return;
  }

  wrap.innerHTML = '';

  if (isMkv || isWebm) {
    const videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.autoplay = true;
    videoEl.style.cssText = 'width:100%;aspect-ratio:16/9;background:#000;border-radius:8px;outline:none;';
    videoEl.src = playableUrl;
    videoEl.innerHTML = 'متصفحك لا يدعم تشغيل هذا الفيديو.';
    wrap.appendChild(videoEl);
    return;
  }

  const container = document.createElement('div');
  container.id = 'dplayer-container';
  wrap.appendChild(container);

  if (currentDPlayer) {
    try { currentDPlayer.destroy(); } catch {}
    currentDPlayer = null;
  }

  currentDPlayer = new DPlayer({
    container,
    autoplay: true,
    theme: '#f5a623',
    lang: 'ar',
    video: {
      url: playableUrl,
      type: isM3u8 ? 'hls' : 'auto',
      customType: {
        hls: (videoEl) => {
          const hls = new Hls();
          hls.loadSource(videoEl.src);
          hls.attachMedia(videoEl);
        },
      },
    },
  });
}

document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchAnime();
});

loadAllSections();