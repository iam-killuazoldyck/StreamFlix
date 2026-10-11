/* ──────────────────────────────────────────────────────────────
   subtitle-core.js : provider logic for the in-player subtitle search.
   Pure logic (no DOM). The UI lives in subtitle-ui.js.

   Providers
     opensubtitles : OpenSubtitles through the public Stremio addon
                     (title search via Cinemeta). No API key.
     subdl         : SubDL REST API (free key from subdl.com/panel/api).
   ────────────────────────────────────────────────────────────── */
(function (root) {
  'use strict';

  /* name, OpenSubtitles 3-letter/2-letter codes, SubDL code, legacy text encoding fallback */
  const LANGS = [
    { name: 'English',              os: ['eng', 'en'],         sd: 'EN',    enc: 'windows-1252' },
    { name: 'Spanish',              os: ['spa', 'es'],         sd: 'ES',    enc: 'windows-1252' },
    { name: 'French',               os: ['fre', 'fra', 'fr'],  sd: 'FR',    enc: 'windows-1252' },
    { name: 'German',               os: ['ger', 'deu', 'de'],  sd: 'DE',    enc: 'windows-1252' },
    { name: 'Italian',              os: ['ita', 'it'],         sd: 'IT',    enc: 'windows-1252' },
    { name: 'Portuguese',           os: ['por', 'pt'],         sd: 'PT',    enc: 'windows-1252' },
    { name: 'Portuguese (Brazil)',  os: ['pob', 'pt-br', 'pb'],sd: 'BR_PT', enc: 'windows-1252' },
    { name: 'Dutch',                os: ['dut', 'nld', 'nl'],  sd: 'NL',    enc: 'windows-1252' },
    { name: 'Swedish',              os: ['swe', 'sv'],         sd: 'SV',    enc: 'windows-1252' },
    { name: 'Danish',               os: ['dan', 'da'],         sd: 'DA',    enc: 'windows-1252' },
    { name: 'Norwegian',            os: ['nor', 'no'],         sd: 'NO',    enc: 'windows-1252' },
    { name: 'Finnish',              os: ['fin', 'fi'],         sd: 'FI',    enc: 'windows-1252' },
    { name: 'Indonesian',           os: ['ind', 'id'],         sd: 'ID',    enc: 'windows-1252' },
    { name: 'Polish',               os: ['pol', 'pl'],         sd: 'PL',    enc: 'windows-1250' },
    { name: 'Czech',                os: ['cze', 'ces', 'cs'],  sd: 'CS',    enc: 'windows-1250' },
    { name: 'Hungarian',            os: ['hun', 'hu'],         sd: 'HU',    enc: 'windows-1250' },
    { name: 'Romanian',             os: ['rum', 'ron', 'ro'],  sd: 'RO',    enc: 'windows-1250' },
    { name: 'Croatian',             os: ['hrv', 'hr'],         sd: 'HR',    enc: 'windows-1250' },
    { name: 'Russian',              os: ['rus', 'ru'],         sd: 'RU',    enc: 'windows-1251' },
    { name: 'Ukrainian',            os: ['ukr', 'uk'],         sd: 'UK',    enc: 'windows-1251' },
    { name: 'Bulgarian',            os: ['bul', 'bg'],         sd: 'BG',    enc: 'windows-1251' },
    { name: 'Serbian',              os: ['srp', 'sr'],         sd: 'SR',    enc: 'windows-1251' },
    { name: 'Greek',                os: ['ell', 'gre', 'el'],  sd: 'EL',    enc: 'windows-1253' },
    { name: 'Turkish',              os: ['tur', 'tr'],         sd: 'TR',    enc: 'windows-1254' },
    { name: 'Hebrew',               os: ['heb', 'he'],         sd: 'HE',    enc: 'windows-1255' },
    { name: 'Arabic',               os: ['ara', 'ar'],         sd: 'AR',    enc: 'windows-1256' },
    { name: 'Persian',              os: ['per', 'fas', 'fa'],  sd: 'FA',    enc: 'windows-1256' },
    { name: 'Urdu',                 os: ['urd', 'ur'],         sd: 'UR',    enc: 'windows-1256' },
    { name: 'Vietnamese',           os: ['vie', 'vi'],         sd: 'VI',    enc: 'windows-1258' },
    { name: 'Thai',                 os: ['tha', 'th'],         sd: 'TH',    enc: 'windows-874' },
    { name: 'Hindi',                os: ['hin', 'hi'],         sd: 'HI',    enc: 'utf-8' },
    { name: 'Bengali',              os: ['ben', 'bn'],         sd: 'BN',    enc: 'utf-8' },
    { name: 'Tamil',                os: ['tam', 'ta'],         sd: 'TA',    enc: 'utf-8' },
    { name: 'Telugu',               os: ['tel', 'te'],         sd: 'TE',    enc: 'utf-8' },
    { name: 'Malayalam',            os: ['mal', 'ml'],         sd: 'ML',    enc: 'utf-8' },
    { name: 'Japanese',             os: ['jpn', 'ja'],         sd: 'JA',    enc: 'shift_jis' },
    { name: 'Korean',               os: ['kor', 'ko'],         sd: 'KO',    enc: 'euc-kr' },
    { name: 'Chinese',              os: ['chi', 'zho', 'zh', 'zht', 'zhc', 'zhs'], sd: 'ZH', enc: 'gbk' },
  ];

  const langByCode = (code) => {
    const c = String(code || '').toLowerCase();
    return LANGS.find(l => l.os.includes(c) || l.sd.toLowerCase() === c || l.name.toLowerCase() === c) || null;
  };
  const langName = (code) => { const l = langByCode(code); return l ? l.name : (code ? String(code).toUpperCase() : 'Unknown'); };

  /* ── "The.Matrix.1999.1080p.BluRay.x264.mkv" / "Show S02E05 …" → search fields ── */
  function cleanQuery(raw) {
    let s = String(raw || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
    let season = null, episode = null;
    const se = /\bS(\d{1,2})\s?E(\d{1,3})\b/i.exec(s) || /\b(\d{1,2})x(\d{2,3})\b/.exec(s);
    if (se) { season = +se[1]; episode = +se[2]; }
    const y = /\b((?:19|20)\d{2})\b/.exec(s);
    const cutRe = /\b(?:S\d{1,2}\s?E\d{1,3}|\d{1,2}x\d{2,3}|(?:19|20)\d{2}|(?:480|576|720|1080|2160)p|4k|bluray|brrip|bdrip|webrip|web-dl|webdl|hdtv|dvdrip|x264|x265|h264|h265|hevc)\b/gi;
    for (const m of s.matchAll(cutRe)) if (m.index > 0) { s = s.slice(0, m.index); break; }   // a title may itself start with a year
    s = s.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    return { query: s, season, episode, year: y ? +y[1] : null };
  }

  /* ── bytes → text (UTF-8 / UTF-16 / legacy code page) ── */
  function decodeBytes(buf, fallbackEnc) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let text;
    if (u8[0] === 0xFF && u8[1] === 0xFE) text = new TextDecoder('utf-16le').decode(u8.subarray(2));
    else if (u8[0] === 0xFE && u8[1] === 0xFF) text = new TextDecoder('utf-16be').decode(u8.subarray(2));
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
      catch (_) {
        try { text = new TextDecoder(fallbackEnc || 'windows-1252').decode(u8); }
        catch (__) { text = new TextDecoder('windows-1252').decode(u8); }
      }
    }
    return text.replace(/^\uFEFF/, '');
  }

  /* ── tiny ZIP / gzip support (subtitle archives are small) ── */
  const inflate = async (u8, fmt) =>
    new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream(fmt))).arrayBuffer());

  function zipEntries(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a valid ZIP archive');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder(), list = [];
    for (let i = 0; i < n && p + 46 <= u8.length && dv.getUint32(p, true) === 0x02014b50; i++) {
      const nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      list.push({
        name: td.decode(u8.subarray(p + 46, p + 46 + nl)),
        method: dv.getUint16(p + 10, true), csize: dv.getUint32(p + 20, true), lho: dv.getUint32(p + 42, true),
      });
      p += 46 + nl + el + cl;
    }
    return list;
  }
  async function zipRead(buf, e) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
    const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflate(data, 'deflate-raw');
    throw new Error('Unsupported ZIP compression method ' + e.method);
  }
  function chooseEntry(entries, season, episode) {
    const subs = entries.filter(e => /\.(srt|vtt)$/i.test(e.name) && !e.name.endsWith('/'));
    if (!subs.length) return null;
    if (subs.length > 1 && season != null && episode != null) {
      const s = +season, ep = +episode;
      const pats = [new RegExp(`S0*${s}[ ._-]?E0*${ep}(?!\\d)`, 'i'), new RegExp(`(?<!\\d)0*${s}x0*${ep}(?!\\d)`, 'i'), new RegExp(`(?:^|[^a-z0-9])E0*${ep}(?!\\d)`, 'i')];
      for (const re of pats) { const m = subs.find(e => re.test(e.name)); if (m) return m; }
    }
    return subs[0];
  }

  /* ── providers ── */
  const CINEMETA = 'https://v3-cinemeta.strem.io';
  const OS_ADDON = 'https://opensubtitles-v3.strem.io';
  const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';
  const SUBDL_DL = 'https://dl.subdl.com';

  const providers = {
    opensubtitles: {
      id: 'opensubtitles', label: 'OpenSubtitles (free, no key)', needsKey: false,

      /** Title lookup (movies + series) through Cinemeta. */
      async findTitles(query, fetchJson) {
        const q = encodeURIComponent(query);
        const [movies, series] = await Promise.all(['movie', 'series'].map(t =>
          fetchJson(`${CINEMETA}/catalog/${t}/top/search=${q}.json`).then(d => d.metas || []).catch(() => [])));
        const out = [];
        for (let i = 0; i < Math.max(movies.length, series.length) && out.length < 8; i++) {
          for (const x of [movies[i], series[i]]) if (x && x.id && out.length < 8)
            out.push({ id: x.id, type: x.type, name: x.name, year: x.releaseInfo || x.year || '' });
        }
        return out;
      },

      async search({ title, season, episode, lang }, fetchJson) {
        const isSeries = title.type === 'series';
        if (isSeries && !(season > 0 && episode > 0)) throw new Error('This is a series: enter a season and episode number.');
        const vid = isSeries ? `${title.id}:${season}:${episode}` : title.id;
        const data = await fetchJson(`${OS_ADDON}/subtitles/${title.type}/${vid}.json`);
        const counts = {};
        return (data.subtitles || [])
          .filter(x => x && x.url)
          .filter(x => !lang || lang.os.includes(String(x.lang || '').toLowerCase()))
          .map(x => {
            const ln = langName(x.lang);
            counts[ln] = (counts[ln] || 0) + 1;
            return { source: 'OpenSubtitles', lang: x.lang, langName: ln, name: `${ln} #${counts[ln]}`, url: x.url, kind: 'text' };
          });
      },
    },

    subdl: {
      id: 'subdl', label: 'SubDL (free API key)', needsKey: true,

      async search({ query, season, episode, lang, key }, fetchJson) {
        if (!key) throw new Error('Enter your SubDL API key first.');
        const p = new URLSearchParams({ api_key: key, film_name: query });
        if (lang) p.set('languages', lang.sd);
        if (season > 0) { p.set('type', 'tv'); p.set('season_number', season); if (episode > 0) p.set('episode_number', episode); }
        const data = await fetchJson(`${SUBDL_API}?${p}`);
        if (data.status === false) throw new Error(data.error || 'SubDL returned an error.');
        return (data.subtitles || []).filter(x => x && x.url).map(x => {
          const code = x.lang || x.language;
          let url = String(x.url);
          if (url.startsWith('/')) url = SUBDL_DL + url;
          else if (!/^https:\/\/dl\.subdl\.com\//.test(url)) return null;   // only trust SubDL's download host
          return { source: 'SubDL', lang: code, langName: langName(code), name: x.release_name || x.name || 'subtitle', author: x.author || '', url, kind: 'zip' };
        }).filter(Boolean);
      },
    },
  };

  /** Download one result and return decoded subtitle text. */
  async function download(result, fetchBuf, ctx) {
    ctx = ctx || {};
    let buf = await fetchBuf(result.url);
    let u8 = new Uint8Array(buf);
    const enc = (langByCode(result.lang) || {}).enc;
    if (u8[0] === 0x1F && u8[1] === 0x8B) { u8 = await inflate(u8, 'gzip'); buf = u8; }
    if (u8[0] === 0x50 && u8[1] === 0x4B) {                       // ZIP
      const entry = chooseEntry(zipEntries(u8), ctx.season, ctx.episode);
      if (!entry) throw new Error('The archive has no .srt/.vtt file (only SRT and VTT are supported).');
      u8 = await zipRead(u8, entry);
    }
    const text = decodeBytes(u8, enc);
    if (!/-->/.test(text)) throw new Error('The downloaded file does not look like a subtitle.');
    return text;
  }

  const api = { LANGS, langByCode, langName, cleanQuery, decodeBytes, zipEntries, zipRead, chooseEntry, providers, download };
  root.SubtitleCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
