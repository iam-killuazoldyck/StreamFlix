/* subtitle-ui.js : "Search online" panel for subtitles.
   Depends on globals from index.html: fetchSubBuffer(), ingestSubtitleText(), toast()
   and on SubtitleCore (subtitle-core.js). */
(function () {
  'use strict';
  const C = SubtitleCore;
  const $ = (id) => document.getElementById(id);
  const el = {
    toggle: $('subSearchToggle'), panel: $('subSearchPanel'),
    provider: $('ssProvider'), lang: $('ssLang'),
    keyRow: $('ssKeyRow'), key: $('ssKey'), keySave: $('ssKeySave'),
    query: $('ssQuery'), season: $('ssSeason'), episode: $('ssEpisode'), go: $('ssSearch'),
    titles: $('ssTitles'), status: $('ssStatus'), results: $('ssResults'),
  };
  const store = {
    get(k) { try { return localStorage.getItem('streamflix.' + k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem('streamflix.' + k, v); } catch (_) {} },
  };

  /* ── setup ── */
  el.provider.innerHTML = '';
  for (const p of Object.values(C.providers)) el.provider.add(new Option(p.label, p.id));
  el.lang.add(new Option('All languages', ''));
  for (const l of C.LANGS) el.lang.add(new Option(l.name, l.os[0]));
  el.provider.value = store.get('subProvider') || 'opensubtitles';
  el.lang.value = store.get('subLang') != null ? store.get('subLang') : 'eng';
  el.key.value = store.get('subdlKey') || '';

  const fetchJson = async (u) => JSON.parse(C.decodeBytes(await fetchSubBuffer(u, { apiCall: true })));
  const num = (input) => { const n = parseInt(input.value, 10); return n > 0 ? n : null; };
  const lang = () => C.langByCode(el.lang.value);
  let seq = 0, activeTitle = null;

  function setStatus(text, isErr) { el.status.textContent = text || ''; el.status.classList.toggle('error', !!isErr); }
  function syncProviderUi() { el.keyRow.hidden = !C.providers[el.provider.value].needsKey; el.titles.innerHTML = ''; }

  /* ── prefill the query from whatever is loaded in the player ── */
  function prefill() {
    let name = ($('metaTitle').textContent || '').trim();
    if (!name || /^(No video loaded|Fetching|Preparing)/i.test(name)) {
      try { name = decodeURIComponent(($('url').value || '').split('?')[0].split('/').pop()); } catch (_) { name = ''; }
    }
    if (!name) return;
    const c = C.cleanQuery(name);
    if (c.query && !/^(stream|video|download|file|play|watch)$/i.test(c.query)) el.query.value = c.query;
    if (c.season) el.season.value = c.season;
    if (c.episode) el.episode.value = c.episode;
  }

  /* ── rendering (always textContent: API data is untrusted) ── */
  function renderTitles(titles) {
    el.titles.innerHTML = '';
    if (titles.length < 2) return;
    for (const t of titles) {
      const b = document.createElement('button');
      b.className = 'ss-chip' + (t === activeTitle ? ' active' : '');
      b.textContent = `${t.name}${t.year ? ' (' + t.year + ')' : ''} · ${t.type === 'series' ? 'TV' : 'Movie'}`;
      b.addEventListener('click', () => { activeTitle = t; renderTitles(titles); loadTitle(t); });
      el.titles.appendChild(b);
    }
  }

  function renderResults(list) {
    el.results.innerHTML = '';
    for (const r of list.slice(0, 80)) {
      const row = document.createElement('div'); row.className = 'ss-item';
      const badge = document.createElement('span'); badge.className = 'ss-lang'; badge.textContent = r.langName;
      const name = document.createElement('span'); name.className = 'ss-name'; name.textContent = r.name; name.title = r.name;
      row.append(badge, name);
      if (r.author) { const by = document.createElement('span'); by.className = 'ss-by'; by.textContent = r.author; row.append(by); }
      const add = document.createElement('button'); add.className = 'cloud-cancel'; add.textContent = 'Add'; row.append(add);
      row.addEventListener('click', () => apply(r, row));
      el.results.appendChild(row);
    }
  }

  /* ── actions ── */
  async function loadTitle(title) {
    const my = ++seq;
    el.results.innerHTML = ''; setStatus('Fetching subtitles…');
    try {
      const list = await C.providers.opensubtitles.search({ title, season: num(el.season), episode: num(el.episode), lang: lang() }, fetchJson);
      if (my !== seq) return;
      renderResults(list);
      setStatus(list.length ? `${list.length} subtitle${list.length > 1 ? 's' : ''} for ${title.name}. Click one to add it.`
                            : 'No subtitles in that language for this title. Try "All languages" or another title.', !list.length);
    } catch (e) { if (my === seq) setStatus(e.message, true); }
  }

  async function search() {
    const my = ++seq;
    const query = el.query.value.trim();
    if (!query) { setStatus('Type a title first.', true); return; }
    el.titles.innerHTML = ''; el.results.innerHTML = ''; setStatus('Searching…');
    store.set('subProvider', el.provider.value); store.set('subLang', el.lang.value);
    const season = num(el.season), episode = num(el.episode);
    try {
      if (el.provider.value === 'subdl') {
        const list = await C.providers.subdl.search({ query, season, episode, lang: lang(), key: el.key.value.trim() }, fetchJson);
        if (my !== seq) return;
        renderResults(list);
        setStatus(list.length ? `${list.length} result${list.length > 1 ? 's' : ''}. Click one to add it.` : 'Nothing found. Try another spelling or "All languages".', !list.length);
        return;
      }
      const P = C.providers.opensubtitles;
      const imdb = /tt\d{6,}/i.exec(query);
      const titles = imdb ? [{ id: imdb[0].toLowerCase(), type: season ? 'series' : 'movie', name: imdb[0], year: '' }] : await P.findTitles(query, fetchJson);
      if (my !== seq) return;
      if (!titles.length) { setStatus('No matching title found.', true); return; }
      activeTitle = (season && titles.find(t => t.type === 'series')) || titles.find(t => t.type === 'movie') || titles[0];
      renderTitles(titles);
      await loadTitle(activeTitle);
    } catch (e) { if (my === seq) setStatus('Search failed: ' + e.message, true); }
  }

  async function apply(r, row) {
    setStatus('Downloading ' + r.name + '…');
    try {
      const text = await C.download(r, (u) => fetchSubBuffer(u, {}), { season: num(el.season), episode: num(el.episode) });
      if (!ingestSubtitleText(text)) { setStatus('Could not read that subtitle file.', true); return; }
      el.results.querySelectorAll('.ss-item.active').forEach(n => n.classList.remove('active'));
      row.classList.add('active');
      setStatus('Loaded: ' + r.name);
    } catch (e) { setStatus('Download failed: ' + e.message, true); }
  }

  /* ── events ── */
  el.toggle.addEventListener('click', () => {
    el.panel.hidden = !el.panel.hidden;
    if (!el.panel.hidden) { syncProviderUi(); if (!el.query.value) prefill(); el.query.focus(); }
  });
  el.provider.addEventListener('change', () => { syncProviderUi(); el.results.innerHTML = ''; setStatus(''); });
  el.lang.addEventListener('change', () => { store.set('subLang', el.lang.value); if (activeTitle && el.provider.value === 'opensubtitles' && el.titles.childElementCount + el.results.childElementCount) loadTitle(activeTitle); });
  el.keySave.addEventListener('click', () => { store.set('subdlKey', el.key.value.trim()); toast('SubDL key saved in this browser'); });
  el.go.addEventListener('click', search);
  for (const i of [el.query, el.season, el.episode]) i.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  syncProviderUi();
})();
