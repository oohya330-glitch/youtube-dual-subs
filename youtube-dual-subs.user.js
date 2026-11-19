// ==UserScript==
// @name         YouTube 中英對照逐字稿（VoiceTube 風格）
// @namespace    lulu.youtube.dualsubs
// @version      3.4.0
// @description  在 YouTube 影片旁邊即時顯示中英對照逐字稿：點單字查中文（離線英漢字典、依句意排序、音標）、唸到的字即時標記、分開不同說話者、目前句子高亮、自動捲動、點句子跳轉、遮英文/遮中文、下載逐字稿；沒有字幕的影片可用聽寫產生逐字稿；影片內也可顯示雙語字幕
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @updateURL    https://raw.githubusercontent.com/oohya330-glitch/youtube-dual-subs/main/youtube-dual-subs.user.js
// @downloadURL  https://raw.githubusercontent.com/oohya330-glitch/youtube-dual-subs/main/youtube-dual-subs.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ===== 可自行修改的設定 ===== */
  const CONFIG = {
    targetLang: 'zh-Hant',   // 翻譯語言：zh-Hant 繁中、zh-Hans 簡中、ja 日文、ko 韓文
    fallbackLang: 'en',      // 判斷不出影片語言時，原文預設用哪種語言
    origColor: '#ffffff',    // 影片內原文字幕顏色
    transColor: '#ffe066',   // 影片內翻譯字幕顏色
    fontScale: 1.0,          // 影片內字幕大小倍率
  };
  /* ============================ */

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('dualsubs2-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('dualsubs2-' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const settings = {
    mode: LS.get('mode', 'off'),          // 影片內字幕：dual / orig / trans / off（預設關閉，看右邊面板）
    hideEn: LS.get('hideEn', false),
    hideZh: LS.get('hideZh', false),
    follow: LS.get('follow', true),
    panelFont: LS.get('panelFont', 15),
    collapsed: LS.get('collapsed', false), // 面板收合
  };
  const save = k => LS.set(k, settings[k]);

  const MODES = ['dual', 'orig', 'trans', 'off'];
  const MODE_LABEL = { dual: '雙語', orig: '原文', trans: '中文', off: '關閉' };
  if (!MODES.includes(settings.mode)) settings.mode = 'off';

  const state = { key: null, videoId: null, orig: [], trans: [], rows: [], version: 0 };
  const nativeFetch = window.fetch.bind(window);

  /* ---------- 攔截 YouTube 播放器的字幕請求 ---------- */
  function sameFamily(a, b) {
    return !!a && !!b && a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
  }

  function getPlayer() { return document.getElementById('movie_player'); }
  function getVideo() { const p = getPlayer(); return p && p.querySelector('video'); }

  // 找出影片「說的語言」的字幕：有自動產生(asr)字幕 → 以它的語言為準，優先用同語言的人工字幕
  function pickOriginal() {
    let tl = [];
    try { tl = getPlayer().getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (e) {}
    if (!tl.length) return null;
    const asr = tl.find(t => t.kind === 'asr');
    const spoken = asr ? asr.languageCode : CONFIG.fallbackLang;
    if (sameFamily(spoken, CONFIG.targetLang)) return null; // 影片本身就是中文
    return tl.find(t => t.kind !== 'asr' && sameFamily(t.languageCode, spoken)) || asr || null;
  }

  function onUrl(url) {
    if (!url || String(url).indexOf('/api/timedtext') === -1) return;
    let u;
    try { u = new URL(url, location.href); } catch (e) { return; }
    const v = u.searchParams.get('v');
    if (!v) return;
    u.searchParams.delete('tlang');
    // 播放器若預設選了中文字幕（台灣地區常見），改抓影片原本語言的字幕當「原文」
    if (sameFamily(u.searchParams.get('lang'), CONFIG.targetLang)) {
      const pick = pickOriginal();
      if (pick) {
        u.searchParams.set('lang', pick.languageCode);
        if (pick.kind === 'asr') u.searchParams.set('kind', 'asr'); else u.searchParams.delete('kind');
        if (pick.name) u.searchParams.set('name', pick.name); else u.searchParams.delete('name');
      }
    }
    const key = [v, u.searchParams.get('lang'), u.searchParams.get('kind'), u.searchParams.get('name')].join('|');
    if (key === state.key) return;
    state.key = key;
    load(u, v, key);
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { onUrl(url); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  window.fetch = function (input) {
    try { onUrl(typeof input === 'string' ? input : (input && input.url)); } catch (e) {}
    return nativeFetch.apply(window, arguments);
  };

  /* ---------- 下載與解析字幕 ---------- */
  function parseJson3(data) {
    const out = [];
    ((data && data.events) || []).forEach(ev => {
      if (!ev.segs) return;
      const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const start = ev.tStartMs || 0;
      out.push({ start, end: start + (ev.dDurationMs || 2000), text });
    });
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  async function getRaw(u) {
    try {
      const r = await nativeFetch(u.toString(), { credentials: 'include' });
      if (!r.ok) return null;
      const txt = await r.text();
      return txt ? JSON.parse(txt) : null;
    } catch (e) { return null; }
  }

  // 逐字（含時間）：自動字幕每個字都有自己的時間；人工字幕依字數比例推算
  function parseWords(data) {
    const words = [];
    const evs = ((data && data.events) || []).filter(ev => ev.segs).slice().sort((a, b) => (a.tStartMs || 0) - (b.tStartMs || 0));
    evs.forEach((ev, ei) => {
      const t0 = ev.tStartMs || 0;
      const nextStart = evs[ei + 1] ? (evs[ei + 1].tStartMs || 0) : Infinity;
      const dur = Math.max(1, Math.min(ev.dDurationMs || 2000, nextStart - t0));   // 不超過下一段的開始，避免順序錯亂
      const hasOff = ev.segs.some(sg => sg.tOffsetMs);
      const total = ev.segs.reduce((a, sg) => a + (sg.utf8 || '').length, 0) || 1;
      let acc = 0;
      ev.segs.forEach(sg => {
        const txt = sg.utf8 || '';
        let local = 0;
        txt.split(/(\s+)/).forEach(w => {
          if (w.trim()) {
            let t = hasOff ? t0 + (sg.tOffsetMs || 0) : t0 + Math.round(dur * (acc + local) / total);
            const prev = words[words.length - 1];
            if (prev && t < prev.t) t = prev.t;          // 保持字幕原本的先後順序
            words.push({ t, w: w.trim(), cs: !words.length || words[words.length - 1].ev !== ei, ev: ei });
          }
          local += w.length;
        });
        acc += txt.length;
      });
    });
    return words;
  }

  // 說話者切換記號：自動字幕的「>>」、人工字幕開頭的「-」或「NAME:」
  const isTurnMark = x => x.w === '>>' || (x.cs && /^[-–—]$/.test(x.w));
  const speakerName = x => (x.cs && /^[A-Z][A-Z.'’-]{1,20}:$/.test(x.w)) ? x.w.slice(0, -1) : null;

  // 依句號／問號斷句；遇到換人說話、停頓或太長也會斷開
  function sentenceRowsFromWords(words) {
    const rows = [];
    let cur = [], turn = false, speaker = null, markT = null;
    const flush = (endT) => {
      if (cur.length) {
        const start = markT != null ? Math.min(markT, cur[0].t) : cur[0].t;
        rows.push({ start, end: endT, en: cur.map(x => x.w).join(' '), zh: '', ws: cur, turn, speaker });
      }
      cur = []; turn = false; speaker = null; markT = null;
    };
    words.forEach((x, i) => {
      const next = words[i + 1];
      if (isTurnMark(x) || speakerName(x)) {
        flush(x.t);
        turn = true;
        speaker = speakerName(x);
        markT = x.t;
        return;                       // 記號本身不顯示
      }
      cur.push(x);
      const len = cur.reduce((a, y) => a + y.w.length + 1, 0);
      const sentEnd = /[.?!…]["'”’)\]]*$/.test(x.w) && !/^(mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|u\.s)\.$/i.test(x.w);
      const gap = next ? next.t - x.t : 0;
      const nextTurn = next && (isTurnMark(next) || speakerName(next));
      if (!next || nextTurn || (sentEnd && len >= 8) || len >= 200 || (gap >= 1500 && cur.length >= 3) ||
          (len >= 120 && /[,;:]$/.test(x.w)) || /^\[[^\]]*\]$/.test(x.w)) {
        flush(next ? next.t : x.t + 2000);
      }
    });
    return rows;
  }

  // 人工字幕配對的列：從文字開頭判斷換人說話
  function markTurns(rows) {
    rows.forEach(r => {
      const m = r.en.match(/^\s*(?:>>|[-–—]\s|([A-Z][A-Z.'’ -]{1,24}):\s)/);
      if (m) { r.turn = true; r.speaker = m[1] || null; r.en = r.en.slice(m[0].length).trim(); }
    });
    return rows;
  }

  async function getTrack(u) {
    try {
      const r = await nativeFetch(u.toString(), { credentials: 'include' });
      if (!r.ok) return [];
      const txt = await r.text();
      return txt ? parseJson3(JSON.parse(txt)) : [];
    } catch (e) {
      console.warn('[逐字稿]', e);
      return [];
    }
  }

  function findCue(cues, t) {
    const idx = lastStartIdx(cues, t);
    for (let i = idx; i >= 0 && i >= idx - 3; i--) if (cues[i].end > t) return cues[i];
    return null;
  }

  function lastStartIdx(cues, t) {
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx;
  }

  function buildRows(o, t) {
    if (!o.length) return t.map(c => ({ start: c.start, end: c.end, en: '', zh: c.text }));
    if (!t.length) return o.map(c => ({ start: c.start, end: c.end, en: c.text, zh: '' }));
    // YouTube 的翻譯常把幾句英文合併成一句、斷句位置也不同，
    // 所以以「中文句子」為單位，把落在它時間範圍內的英文片段合在一起
    const rows = t.map(c => ({ start: c.start, end: c.end, en: [], zh: c.text }));
    o.forEach((c, i) => {
      const next = o[i + 1];
      const end = next ? Math.min(c.end, next.start) : c.end;
      const mid = (c.start + Math.max(c.start, end)) / 2;
      let idx = lastStartIdx(t, mid);
      if (idx < 0) idx = 0;
      const en = rows[idx].en;
      if (en[en.length - 1] !== c.text) en.push(c.text);
    });
    // 沒分到英文的中文句子，併入前一句（或下一句）
    const out = [];
    rows.forEach(r => {
      if (r.en.length || !out.length) out.push(r);
      else { const p = out[out.length - 1]; p.zh += ' ' + r.zh; p.end = r.end; }
    });
    if (out.length > 1 && !out[0].en.length) { out[1].zh = out[0].zh + ' ' + out[1].zh; out[1].start = out[0].start; out.shift(); }
    return out.map(r => {
      const en = r.en.join(' ');
      return { start: r.start, end: r.end, en, zh: r.zh === en ? '' : r.zh };
    });
  }

  async function load(u, v, key) {
    state.videoId = v; state.orig = []; state.trans = []; state.rows = []; state.version++;
    const ou = new URL(u.toString());
    ou.searchParams.set('fmt', 'json3');
    const tu = new URL(ou.toString());
    tu.searchParams.set('tlang', CONFIG.targetLang);
    const [oRaw, t] = await Promise.all([getRaw(ou), getTrack(tu)]);
    if (state.key !== key) return;
    const o = parseJson3(oRaw);
    state.orig = o; state.trans = t;
    let rows = null;
    const asr = ou.searchParams.get('kind') === 'asr';
    // 1) 影片有「人工」英文字幕＋人工中文字幕（例如 TED）→ 直接用人工翻譯
    if (o.length && !asr) {
      const h = pickHumanTarget();
      if (h) {
        const hu = new URL(ou.toString());
        ['kind', 'name', 'tlang'].forEach(k => hu.searchParams.delete(k));
        hu.searchParams.set('lang', h.languageCode);
        if (h.name) hu.searchParams.set('name', h.name);
        const ht = await getTrack(hu);
        if (state.key !== key) return;
        if (ht.length && alignedRatio(o, ht) >= 0.6) {
          rows = markTurns(buildRows(o, ht));
          rows.forEach(r => { r.src = 'human'; });
          state.trans = ht;
        }
      }
    }
    // 2) 其他情況 → 先把英文碎片合併成完整句子，再逐句用 Google 翻譯
    if (!rows) {
      if (o.length) {
        const words = parseWords(oRaw);
        rows = words.length ? sentenceRowsFromWords(words) : markTurns(sentenceRows(o));
        rows.forEach(r => { r.zh = ''; r.pending = true; r.src = 'google'; });
      } else {
        rows = markTurns(buildRows(o, t));
        rows.forEach(r => { r.src = 'youtube'; });
      }
    }
    state.rows = rows;
    state.version++;
    console.log('[逐字稿] 已載入：原文 ' + o.length + ' 句 → ' + rows.length + ' 列（' + rows[0]?.src + '）');
    if (rows.some(r => r.pending)) translateRows(rows, key);
  }

  function pickHumanTarget() {
    let tl = [];
    try { tl = getPlayer().getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (e) {}
    const fam = tl.filter(t => t.kind !== 'asr' && sameFamily(t.languageCode, CONFIG.targetLang));
    if (!fam.length) return null;
    const pref = CONFIG.targetLang === 'zh-Hant' ? ['zh-TW', 'zh-Hant', 'zh-HK']
      : CONFIG.targetLang === 'zh-Hans' ? ['zh-CN', 'zh-Hans', 'zh-SG'] : [CONFIG.targetLang];
    for (const p of pref) { const f = fam.find(t => t.languageCode === p); if (f) return f; }
    if (CONFIG.targetLang.startsWith('zh')) return fam.find(t => t.languageCode === 'zh') || null;
    return fam[0];
  }

  // 人工中文字幕的時間點是否跟英文對得上
  function alignedRatio(o, t) {
    let ok = 0;
    o.forEach(c => { const i = lastStartIdx(t, c.start + 300); if (i >= 0 && Math.abs(t[i].start - c.start) <= 300) ok++; });
    return ok / o.length;
  }

  // 把字幕碎片合併成完整句子（遇到句號/問號、停頓、或太長時斷開）
  function sentenceRows(o) {
    const rows = [];
    let cur = null;
    o.forEach((c, i) => {
      const next = o[i + 1];
      if (!cur) cur = { start: c.start, end: c.end, parts: [] };
      if (cur.parts[cur.parts.length - 1] !== c.text) cur.parts.push(c.text);
      cur.end = next ? Math.min(Math.max(cur.end, c.end), next.start) : Math.max(cur.end, c.end);
      const text = cur.parts.join(' ');
      const gap = next ? next.start - c.end : 0;
      const sentEnd = /[.?!…]["'”’)\]]*$/.test(c.text);
      if (!next || (sentEnd && text.length >= 8) || text.length >= 180 || gap >= 1200 ||
          (text.length >= 110 && /[,;:]$/.test(c.text))) {
        rows.push({ start: cur.start, end: cur.end, en: text, zh: '' });
        cur = null;
      }
    });
    return rows;
  }

  // 連線失敗或被 Google 暫時限流（429）時，等一下自動重試
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchRetry(url, opt, tries) {
    let last = '';
    for (let a = 0; a < (tries || 3); a++) {
      if (a) await sleep(700 * a * a + Math.random() * 300);
      try {
        const r = await nativeFetch(url, opt);
        if (r.ok) return r;
        last = 'HTTP ' + r.status;
        if (r.status !== 429 && r.status < 500) break;     // 其他錯誤重試也沒用
      } catch (e) { last = e.message || '連線失敗'; }
    }
    throw new Error(last);
  }

  async function gtxBatch(lines) {
    const r = await fetchRetry('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' + TL + '&dt=t&dj=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ q: lines.join('\n') }),
    }, 2);
    return transOf(await r.json()).split('\n');
  }

  function setZh(rows, i, zh, failed, fromYouTube) {
    const r = rows[i];
    r.zh = zh; r.pending = false; r.zhYT = !!fromYouTube;
    if (rows !== state.rows) return;
    const it = items[i];
    const z = it && it.querySelector('.dt-zh');
    if (z) { z.textContent = zh; z.classList.remove('pending'); z.classList.toggle('failed', !!failed); z.classList.toggle('yt', !!fromYouTube); }
  }

  /* ---------- 翻譯：只翻正在看的段落、結果存起來、Google 不能用時改用 YouTube 翻譯 ---------- */
  const TR_CACHE_KEY = 'dualsubs3-trg';   // 只存 Google 翻譯
  try { localStorage.removeItem('dualsubs2-tr'); } catch (e) {}
  let trCache = null;
  function trCacheGet() {
    if (!trCache) { try { trCache = JSON.parse(localStorage.getItem(TR_CACHE_KEY) || '{}'); } catch (e) { trCache = {}; } }
    return trCache;
  }
  let trSaveTimer = 0;
  function trCacheSave() {
    clearTimeout(trSaveTimer);
    trSaveTimer = setTimeout(() => {
      const c = trCacheGet(), keys = Object.keys(c);
      if (keys.length > 6000) keys.slice(0, keys.length - 5000).forEach(k => delete c[k]);   // 只保留最近約 5000 句
      try { localStorage.setItem(TR_CACHE_KEY, JSON.stringify(c)); } catch (e) {}
    }, 1500);
  }
  const trKey = en => TL + '|' + en;

  let googleBlockedUntil = 0;    // Google 限流／封鎖時，暫停使用一段時間

  // 備案：把 YouTube 自動翻譯的中文，依時間放進對應的句子
  function youtubeZhFor(rows, i) {
    const t = state.trans || [];
    if (!t.length) return '';
    const r = rows[i], end = rows[i + 1] ? rows[i + 1].start : r.end;
    const parts = [];
    t.forEach(c => {
      const mid = c.start + Math.min(c.end - c.start, 4000) / 2;
      if (mid >= r.start && mid < end && parts[parts.length - 1] !== c.text) parts.push(c.text);
    });
    return parts.join('');
  }

  /* ---------- Chrome 內建翻譯（在電腦上翻譯，不連 Google 伺服器、不會被封鎖） ---------- */
  const builtin = { state: 'unknown', tr: null, initP: null };
  const builtinLang = () => CONFIG.targetLang === 'zh-Hans' ? 'zh' : CONFIG.targetLang;
  function builtinInit(fromClick) {
    if (builtin.tr) return Promise.resolve(builtin.tr);
    if (builtin.state === 'unavailable') return Promise.resolve(null);
    if (builtin.initP && !fromClick) return builtin.initP;
    builtin.initP = (async () => {
      const T = window.Translator;
      if (!T || !T.availability) { builtin.state = 'unavailable'; return null; }
      try {
        const opts = { sourceLanguage: 'en', targetLanguage: builtinLang() };
        const av = await Promise.race([T.availability(opts), sleep(4000).then(() => 'timeout')]);
        if (av === 'unavailable' || av === 'timeout' || av === 'no') { builtin.state = 'unavailable'; return null; }
        if (av !== 'available' && av !== 'readily' && !fromClick) { builtin.state = 'needs-click'; refreshBuiltinBar(); return null; }
        builtin.state = 'downloading'; refreshBuiltinBar();
        builtin.tr = await T.create(Object.assign({}, opts, {
          monitor(m) { m.addEventListener('downloadprogress', e => { builtin.progress = e.loaded; refreshBuiltinBar(); }); },
        }));
        builtin.state = 'ready'; refreshBuiltinBar();
        return builtin.tr;
      } catch (e) {
        builtin.state = e && e.name === 'NotAllowedError' ? 'needs-click' : 'unavailable';
        refreshBuiltinBar();
        return null;
      }
    })();
    return builtin.initP;
  }
  async function builtinTranslate(text) {
    const t = builtin.tr || await builtinInit(false);
    if (!t) return null;
    return (await t.translate(text)).trim();
  }

  /* ---------- 聽寫模式：影片沒有字幕時，用瀏覽器的語音辨識「聽」影片的聲音 ---------- */
  const dict = { on: false, lang: 'en-US', rec: null, track: null, videoId: null, session: 0, resStart: {}, restartT: 0, msg: '' };
  let dictBar = null, interimEl = null;

  function noCaptionTracks(player) {
    let tl = [];
    try { tl = player.getOption('captions', 'tracklist', { includeAsr: true }) || []; } catch (e) {}
    if (tl.length) return false;
    const cc = player.querySelector('.ytp-subtitles-button');
    return !cc || cc.offsetParent === null || cc.getAttribute('aria-disabled') === 'true' || cc.disabled;
  }

  let dictBarShown = null, dictBarState = '';
  function refreshDictBarLazy(show) {
    const st = show + '|' + dict.on + '|' + dict.lang + '|' + dict.msg;
    if (st !== dictBarState) { dictBarState = st; refreshDictBar(show); }
  }
  function refreshDictBar(show) {
    dictBarState = show + '|' + dict.on + '|' + dict.lang + '|' + dict.msg;
    if (!dictBar) return;
    dictBar.style.display = show ? '' : 'none';
    if (!show) return;
    dictBar.textContent = '';
    if (dict.on) {
      dictBar.append(el('span', 'dt-rec', '●'), document.createTextNode(' 聽寫中（' + (dict.lang.startsWith('en') ? '英文' : '中文') + '）：影片播放時才會聽寫 '));
      const b = el('button', 'dt-btn', '停止');
      b.addEventListener('click', e => { e.stopPropagation(); stopDictation(); });
      dictBar.append(b);
    } else {
      dictBar.append(document.createTextNode(dict.msg || '這支影片沒有字幕。要用聽寫產生逐字稿嗎？ '));
      [['en-US', '聽寫英文'], ['zh-TW', '聽寫中文']].forEach(([lang, label]) => {
        const b = el('button', 'dt-btn on', label);
        b.addEventListener('click', e => { e.stopPropagation(); startDictation(lang); });
        dictBar.append(b);
      });
    }
  }

  function startDictation(lang) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const v = getVideo(), player = getPlayer();
    if (!SR || !v || !player) { dict.msg = '這個瀏覽器不支援聽寫（請用新版 Chrome 或 Edge）。 '; refreshDictBar(true); return; }
    const cur = currentVideoId(player);
    if (dict.videoId !== cur || !String(state.key).startsWith('dict:')) {
      state.key = 'dict:' + cur; state.videoId = cur; state.orig = []; state.trans = []; state.rows = []; state.version++;
    }
    dict.on = true; dict.lang = lang; dict.videoId = cur; dict.msg = '';
    try {
      if (!dict.track || dict.track.readyState !== 'live') {
        const st = v.captureStream ? v.captureStream() : v.mozCaptureStream();
        dict.track = st.getAudioTracks()[0] || null;
      }
    } catch (e) { dict.track = null; }
    if (!dict.track) { dict.on = false; dict.msg = '無法取得影片的聲音，沒辦法聽寫。 '; refreshDictBar(true); return; }
    refreshDictBar(true);
    if (v.paused) v.play(); else runRec();
  }

  function stopDictation() {
    dict.on = false;
    clearTimeout(dict.restartT);
    if (dict.rec) { try { dict.rec.stop(); } catch (e) {} }
    setInterim('');
    refreshDictBar(true);
  }

  function runRec() {
    if (!dict.on || dict.rec) return;
    const v = getVideo();
    if (!v || v.paused) return;                     // 影片播放時才聽寫（暫停就停）
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = dict.lang; rec.continuous = true; rec.interimResults = true;
    const sess = ++dict.session;
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], k = sess + ':' + i;
        if (!(k in dict.resStart)) dict.resStart[k] = Math.max(0, getVideo().currentTime * 1000 - 1500);
        if (r.isFinal) { addDictRow(dict.resStart[k], r[0].transcript); delete dict.resStart[k]; setInterim(''); }
        else setInterim(r[0].transcript);
      }
    };
    rec.onerror = e => {
      if (/not-allowed|service-not-allowed|language-not-supported|audio-capture/.test(e.error)) {
        dict.on = false;
        dict.msg = '語音辨識無法使用（' + e.error + '）。 ';
        refreshDictBar(true);
      }
    };
    rec.onend = () => {
      dict.rec = null;
      if (dict.on) { clearTimeout(dict.restartT); dict.restartT = setTimeout(runRec, 300); }   // 語音辨識會自己停，自動接續
    };
    try { rec.start(dict.track); dict.rec = rec; }
    catch (e) { dict.on = false; dict.msg = '這個瀏覽器還不支援「聽影片聲音」的聽寫（' + e.message + '）。 '; refreshDictBar(true); }
  }

  function setInterim(text) {
    if (!list) return;
    if (!text) { if (interimEl) { interimEl.remove(); interimEl = null; } return; }
    if (!interimEl) interimEl = el('div', 'dt-interim');
    interimEl.textContent = '🎙 ' + text;
    if (interimEl.parentNode !== list || list.lastChild !== interimEl) list.append(interimEl);
  }

  async function addDictRow(start, text) {
    text = (text || '').trim();
    if (!text) return;
    const en = dict.lang.startsWith('en');
    if (en) text = text[0].toUpperCase() + text.slice(1) + (/[.?!]$/.test(text) ? '' : '.');
    const v = getVideo();
    const r = { start, end: v ? v.currentTime * 1000 : start + 3000, en: text, zh: '', pending: en, src: 'dictation' };
    const rows = state.rows;
    let i = rows.length;
    while (i > 0 && rows[i - 1].start > start) i--;   // 依時間插入（往回拉進度條時也會排好）
    rows.splice(i, 0, r);
    state.version++;
    if (!en) return;
    let z = null;
    if (Date.now() >= googleBlockedUntil) { try { z = (await gtxBatch([r.en]))[0]; } catch (e) { googleBlockedUntil = Date.now() + 5 * 60 * 1000; } }
    if (!z) { try { z = await builtinTranslate(r.en); } catch (e) {} }
    r.zh = (z || '（暫時無法翻譯）').trim(); r.pending = false;
    if (state.rows === rows) state.version++;
  }

  let builtinBar = null;
  function refreshBuiltinBar() {
    if (!builtinBar) return;
    const st = builtin.state;
    builtinBar.style.display = (st === 'needs-click' || st === 'downloading') ? '' : 'none';
    builtinBar.textContent = '';
    if (st === 'needs-click') {
      builtinBar.append(document.createTextNode('改用瀏覽器內建翻譯（在電腦上翻譯，不會被封鎖） '));
      const b = el('button', 'dt-btn on', '啟用');
      b.addEventListener('click', async e => {
        e.stopPropagation();
        await builtinInit(true);
        if (builtin.tr) retranslateAll();
      });
      builtinBar.append(b);
    } else if (st === 'downloading') {
      builtinBar.append(document.createTextNode('正在下載內建翻譯模型（只需一次）… ' + (builtin.progress != null ? Math.round(builtin.progress * 100) + '%' : '')));
    }
  }
  // 內建翻譯可用之後，把之前用 YouTube 備案的句子重新翻一次
  function retranslateAll() {
    const rows = state.rows;
    if (!rows || !tr.rows) return;
    rows.forEach(r => { if (r.zhYT) { r.pending = true; } });
    tr.started = new Set();
    if (activeIdx >= 0) ensureTranslated(activeIdx); else ensureTranslated(0);
  }

  let trSrcText = '';
  function setSrcLabel(text) { trSrcText = text; if (srcLabel) srcLabel.textContent = text; }

  function useYouTubeFallback(rows, idxs) {
    idxs.forEach(i => setZh(rows, i, youtubeZhFor(rows, i) || '（暫時無法翻譯）', false, true));
    setSrcLabel('中文：YouTube 翻譯（Google 暫時無法使用）');
  }

  // 用 Chrome 內建翻譯（品質較差，只在 Google 不能用時使用；結果不存起來，下次會再試 Google）
  async function translateWithBuiltin(rows, need, key) {
    const bt = builtin.tr || await builtinInit(false);
    if (!bt) return false;
    for (const i of need) {
      if (state.key !== key) return true;
      try { setZh(rows, i, (await bt.translate(rows[i].en)).trim()); }
      catch (e) { setZh(rows, i, youtubeZhFor(rows, i) || '（暫時無法翻譯）', false, true); }
    }
    setSrcLabel('中文：瀏覽器內建翻譯（Google 暫時無法使用）');
    return true;
  }

  async function translateChunk(rows, idxs, key) {
    // 先用存起來的 Google 翻譯
    const cache = trCacheGet();
    const need = [];
    idxs.forEach(i => { const z = cache[trKey(rows[i].en)]; if (z) setZh(rows, i, z); else need.push(i); });
    if (!need.length) return;
    // 1) Google 翻譯（品質最好）
    if (Date.now() >= googleBlockedUntil) {
      let parts = null, err = null;
      try { parts = await gtxBatch(need.map(i => rows[i].en)); } catch (e) { err = e; }
      if (state.key !== key) return;
      if (parts && parts.length === need.length) {
        need.forEach((i, k) => { const z = parts[k].trim(); setZh(rows, i, z); cache[trKey(rows[i].en)] = z; });
        trCacheSave();
        setSrcLabel('中文：Google 翻譯');
        return;
      }
      if (!err && need.length > 1) {   // 行數對不上 → 拆小再翻
        const h = need.length >> 1;
        await translateChunk(rows, need.slice(0, h), key);
        await translateChunk(rows, need.slice(h), key);
        return;
      }
      if (!err) { setZh(rows, need[0], parts.join(' ').trim()); return; }
      googleBlockedUntil = Date.now() + 5 * 60 * 1000;     // 5 分鐘內不再打擾 Google
    }
    // 2) Google 不能用 → Chrome 內建翻譯；3) 再不行 → YouTube 翻譯
    if (await translateWithBuiltin(rows, need, key)) return;
    useYouTubeFallback(rows, need);
  }

  // 依需要翻譯：每 25 句一批，只翻「正在播放」和「正在看」的那幾批
  const tr = { rows: null, key: null, chunks: [], started: new Set(), busy: false, queue: [] };
  function translateRows(rows, key) {
    tr.rows = rows; tr.key = key; tr.started = new Set(); tr.queue = []; tr.chunks = [];
    trSrcText = '';
    for (let i = 0; i < rows.length; i += 25) tr.chunks.push(rows.slice(i, i + 25).map((_, k) => i + k));
    // 先把存起來的翻譯全部填上（不用連網）
    const cache = trCacheGet();
    rows.forEach((r, i) => { const z = cache[trKey(r.en)]; if (z) setZh(rows, i, z); });
    const v = getVideo();
    ensureTranslated(Math.max(0, lastStartIdx(rows, v ? v.currentTime * 1000 : 0)));
  }
  function ensureTranslated(i) {
    if (!tr.rows || tr.rows !== state.rows || i < 0) return;
    const c = Math.floor(i / 25);
    [c, c + 1].forEach(k => {
      if (k < tr.chunks.length && !tr.started.has(k)) {
        tr.started.add(k);
        if (tr.chunks[k].some(j => tr.rows[j].pending)) tr.queue.push(k);
      }
    });
    pumpTranslate();
  }
  async function pumpTranslate() {
    if (tr.busy) return;
    tr.busy = true;
    while (tr.queue.length) {
      const k = tr.queue.shift(), key = tr.key, rows = tr.rows;
      if (state.key !== key) break;
      await translateChunk(rows, tr.chunks[k], key);
      if (Date.now() >= googleBlockedUntil) await sleep(500);   // 每批之間稍微間隔
    }
    tr.busy = false;
  }

  /* ---------- 共用 ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = n => String(n).padStart(2, '0');
    return h ? h + ':' + p(m) + ':' + p(ss) : m + ':' + p(ss);
  }

  function currentVideoId(player) {
    try { const d = player.getVideoData && player.getVideoData(); if (d && d.video_id) return d.video_id; } catch (e) {}
    return new URLSearchParams(location.search).get('v');
  }

  function addStyle() {
    const css = `
#dualsubs-box{position:absolute;left:50%;transform:translateX(-50%);bottom:13%;z-index:60;width:92%;text-align:center;pointer-events:none;display:none;transition:bottom .15s}
.ytp-autohide #dualsubs-box{bottom:5%}
#dualsubs-box>div{display:table;margin:3px auto;padding:1px 8px;background:rgba(8,8,8,.75);border-radius:4px;line-height:1.35;white-space:pre-wrap;font-family:"YouTube Noto",Roboto,"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif}
#dualsubs-box>div:empty{display:none}
html.dualsubs-on .ytp-caption-window-container{display:none!important}
#dualsubs-btn{font-size:13px;font-weight:600;width:auto!important;padding:0 8px!important;color:#fff;vertical-align:top;text-align:center}

#dt-panel{--dt-fs:15px;display:flex;flex-direction:column;box-sizing:border-box;margin-bottom:16px;border:1px solid rgba(0,0,0,.12);border-radius:12px;overflow:hidden;background:#fff;color:#0f0f0f;font-family:Roboto,"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif}
html[dark] #dt-panel{background:#1f1f1f;color:#f1f1f1;border-color:rgba(255,255,255,.12)}
#dt-panel .dt-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.25)}
#dt-panel .dt-title{font-size:16px;font-weight:700}
#dt-panel .dt-src{font-size:11px;color:#888;margin-right:auto;align-self:flex-end;padding-bottom:2px}
#dt-panel .dt-tools{display:flex;flex-wrap:wrap;gap:4px}
#dt-panel .dt-btn{font-size:12px;font-family:inherit;padding:5px 9px;border-radius:14px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer;line-height:1.2}
#dt-panel .dt-btn:hover{background:rgba(128,128,128,.15)}
#dt-panel .dt-btn.on{background:#065fd4;border-color:#065fd4;color:#fff}
#dt-panel .dt-listwrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
#dt-panel .dt-builtin{padding:8px 12px;font-size:12px;background:rgba(6,95,212,.08);border-bottom:1px solid rgba(128,128,128,.2)}
#dt-panel .dt-builtin .dt-btn{margin-left:6px}
#dt-panel .dt-dict{background:rgba(229,57,53,.07)}
#dt-panel .dt-rec{color:#e53935;animation:dtblink 1.2s infinite}
@keyframes dtblink{50%{opacity:.25}}
#dt-panel .dt-interim{padding:8px 12px 8px 62px;color:#888;font-style:italic;font-size:var(--dt-fs)}
#dt-panel.collapsed .dt-builtin{display:none!important}
#dt-panel .dt-back{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);z-index:2;border:none;border-radius:16px;padding:6px 14px;background:#065fd4;color:#fff;font-size:13px;font-family:inherit;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
#dt-panel .dt-back:hover{background:#0b57d0}
#dt-panel.collapsed .dt-listwrap{display:none}
#dt-panel .dt-list{position:relative;flex:1;min-height:0;overflow-y:auto;padding:4px 0;font-size:var(--dt-fs)}
#dt-panel .dt-item{display:flex;gap:10px;padding:10px 12px;margin:2px 8px;cursor:pointer;border-radius:10px;transition:background .15s}
#dt-panel .dt-item:hover{background:rgba(128,128,128,.08)}
#dt-panel .dt-item.active{background:#ececec}
html[dark] #dt-panel .dt-item.active{background:#333}
#dt-panel .dt-item:not(.active) .dt-en{color:#707070}
html[dark] #dt-panel .dt-item:not(.active) .dt-en{color:#9a9a9a}
#dt-panel .dt-time{flex:none;min-width:40px;font-size:12px;padding-top:3px;color:#065fd4;font-variant-numeric:tabular-nums}
html[dark] #dt-panel .dt-time{color:#3ea6ff}
#dt-panel .dt-en{line-height:1.45}
#dt-panel .dt-zh{line-height:1.45;margin-top:2px;color:#606060}
html[dark] #dt-panel .dt-zh{color:#aaa}
#dt-panel .dt-zh.pending{font-style:italic;opacity:.55}
#dt-panel .dt-zh.failed{color:#c62828}
#dt-panel.hide-en .dt-en,#dt-panel.hide-zh .dt-zh{filter:blur(5px);transition:filter .15s}
#dt-panel.hide-en .dt-item:hover .dt-en,#dt-panel.hide-zh .dt-item:hover .dt-zh{filter:none}
#dt-panel.collapsed .dt-tools,#dt-panel.collapsed .dt-list,#dt-panel.collapsed .dt-empty{display:none!important}
#dt-panel.collapsed .dt-head{border-bottom:none}
#dt-panel .dt-toggle{margin-left:auto;font-weight:600}
#dt-panel .dt-tok{border-radius:3px;transition:background .15s,color .15s}
#dt-panel .dt-item.active .dt-tok.said{color:#7e57c2}
html[dark] #dt-panel .dt-item.active .dt-tok.said{color:#b39ddb}
#dt-panel .dt-item.active .dt-tok.speak{color:#7e57c2;background:rgba(126,87,194,.18)}
html[dark] #dt-panel .dt-item.active .dt-tok.speak{color:#e1d5ff;background:rgba(149,117,205,.45)}
#dt-panel .dt-item.turn{margin-top:12px;position:relative}
#dt-panel .dt-item.turn::before{content:'';position:absolute;left:4px;right:4px;top:-7px;border-top:1px dashed rgba(128,128,128,.35)}
#dt-panel .dt-spk{font-size:11px;font-weight:600;color:#888;margin-bottom:3px}
#dt-panel .dt-w{cursor:pointer;border-radius:3px;padding:0 1px;margin:0 -1px}
#dt-panel .dt-w:hover{background:rgba(6,95,212,.16)}
#dt-panel .dt-w.sel{background:#065fd4;color:#fff}
#dt-pop{position:fixed;z-index:99999;width:310px;max-height:65vh;overflow:auto;box-sizing:border-box;background:#fff;color:#0f0f0f;border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.28);padding:12px 14px 14px;font-family:Roboto,"Noto Sans TC","Microsoft JhengHei","PingFang TC",sans-serif;font-size:14px;line-height:1.55}
html[dark] #dt-pop{background:#2a2a2a;color:#f1f1f1}
#dt-pop .dp-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
#dt-pop .dp-word{font-size:21px;font-weight:700;margin-right:auto}
#dt-pop .dp-ico{border:none;background:transparent;color:inherit;cursor:pointer;font-size:16px;padding:2px 6px;border-radius:6px}
#dt-pop .dp-ico:hover{background:rgba(128,128,128,.18)}
#dt-pop .dp-phon{display:flex;flex-wrap:wrap;gap:4px 12px;margin:-2px 0 6px;font-size:14px;color:#444}
html[dark] #dt-pop .dp-phon{color:#ccc}
#dt-pop .dp-ph{display:inline-flex;align-items:center;gap:3px}
#dt-pop .dp-acc{font-size:11px;padding:0 4px;border-radius:4px;background:rgba(128,128,128,.2);margin-right:2px}
#dt-pop .dp-say{font-size:14px;padding:0 4px}
#dt-pop .dp-meta{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px}
#dt-pop .dp-link{margin-left:auto;color:#065fd4;text-decoration:none}
html[dark] #dt-pop .dp-link{color:#3ea6ff}
#dt-pop .dp-link:hover{text-decoration:underline}
#dt-pop .dp-base{font-size:12px;color:#888;margin:-4px 0 6px}
#dt-pop .dp-ctx{background:#e8f5e9;border-left:4px solid #2e7d32;border-radius:6px;padding:8px 10px;margin-bottom:8px}
html[dark] #dt-pop .dp-ctx{background:#1e3a22}
#dt-pop .dp-ctx-guess{background:#f3f3f3;border-left-color:#999}
html[dark] #dt-pop .dp-ctx-guess{background:#383838}
#dt-pop .dp-label{font-size:12px;font-weight:700;color:#2e7d32;margin-bottom:2px}
#dt-pop .dp-ctx-guess .dp-label,#dt-pop .dp-label2{color:#888}
#dt-pop .dp-main{font-size:18px;font-weight:700}
#dt-pop .dp-pos{display:inline-block;font-size:11px;font-weight:500;padding:0 6px;margin-right:6px;border-radius:8px;background:rgba(128,128,128,.2);vertical-align:2px}
#dt-pop .dp-sent{font-size:13px;color:#555;margin-top:4px}
html[dark] #dt-pop .dp-sent{color:#bbb}
#dt-pop .dp-sent mark{background:#ffe066;color:#000;padding:0 1px;border-radius:2px}
#dt-pop .dp-other{margin:3px 0}
#dt-pop .dp-credit{margin-top:8px;font-size:10px;color:#aaa;text-align:right}
#dt-panel .dt-empty{padding:28px 16px;color:#888;font-size:14px;line-height:1.6;white-space:pre-line;text-align:center}`;
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ---------- 右側逐字稿面板 ---------- */
  let backBtn = null, srcLabel = null, speakRow = null, speakK = -1, lastRenderedVid = null;
  let panel, list, emptyMsg, items = [], activeIdx = -1, renderedKey = '', lastUserScroll = 0;
  const btns = {};

  function buildPanel() {
    panel = el('div'); panel.id = 'dt-panel';
    const head = el('div', 'dt-head');
    head.append(el('span', 'dt-title', '中英對照逐字稿'));
    srcLabel = el('span', 'dt-src');
    head.append(srcLabel);
    const tools = el('div', 'dt-tools');
    const mk = (id, label, title, fn) => {
      const b = el('button', 'dt-btn', label);
      b.title = title;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); refreshPanelSettings(); });
      tools.append(b);
      btns[id] = b;
    };
    mk('hideEn', '遮英文', '把英文模糊（滑鼠移過去才看得到），練聽力用', () => { settings.hideEn = !settings.hideEn; save('hideEn'); });
    mk('hideZh', '遮中文', '把中文模糊（滑鼠移過去才看得到）', () => { settings.hideZh = !settings.hideZh; save('hideZh'); });
    mk('follow', '自動捲動', '跟著影片自動捲到目前的句子', () => { settings.follow = !settings.follow; save('follow'); lastUserScroll = 0; scrollToActive(true); });
    mk('smaller', 'A−', '字變小', () => { settings.panelFont = Math.max(11, settings.panelFont - 1); save('panelFont'); });
    mk('bigger', 'A+', '字變大', () => { settings.panelFont = Math.min(26, settings.panelFont + 1); save('panelFont'); });
    mk('download', '下載', '下載中英對照逐字稿（.txt）', downloadTxt);
    head.append(tools);
    const tg = el('button', 'dt-btn dt-toggle');
    tg.addEventListener('click', e => {
      e.stopPropagation();
      settings.collapsed = !settings.collapsed; save('collapsed');
      refreshPanelSettings();
      const pl = getPlayer(); if (pl) ensurePanel(pl);
      if (!settings.collapsed) scrollToActive(true);
    });
    head.append(tg);
    btns.toggle = tg;

    list = el('div', 'dt-list');
    const userScroll = () => { lastUserScroll = Date.now(); };
    list.addEventListener('wheel', userScroll, { passive: true });
    list.addEventListener('touchmove', userScroll, { passive: true });
    list.addEventListener('pointerdown', e => { if (e.target === list) userScroll(); });   // 拖曳捲軸
    list.addEventListener('keydown', userScroll);
    let scrollT = 0;
    list.addEventListener('scroll', () => {
      clearTimeout(scrollT);
      scrollT = setTimeout(() => {          // 捲到哪裡就翻譯哪裡
        let lo = 0, hi = items.length - 1, first = 0;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (items[m].offsetTop + items[m].offsetHeight >= list.scrollTop) { first = m; hi = m - 1; } else lo = m + 1; }
        ensureTranslated(first);
        ensureTranslated(first + 12);
      }, 250);
    }, { passive: true });
    list.addEventListener('click', e => {
      const w = e.target.closest('.dt-w');
      if (w) {
        e.stopPropagation();
        const row = state.rows[+w.closest('.dt-item').dataset.i];
        if (row) showWord(w, row);
        return;
      }
      const it = e.target.closest('.dt-item');
      if (!it) return;
      const r = state.rows[+it.dataset.i];
      const v = getVideo();
      if (r && v) {
        v.currentTime = r.start / 1000 + 0.01;
        lastUserScroll = 0;
        if (v.paused) v.play();
      }
    });
    emptyMsg = el('div', 'dt-empty');
    const wrap = el('div', 'dt-listwrap');
    backBtn = el('button', 'dt-back', '↓ 回到目前句子');
    backBtn.style.display = 'none';
    backBtn.addEventListener('click', e => { e.stopPropagation(); lastUserScroll = 0; scrollToActive(true); backBtn.style.display = 'none'; });
    wrap.append(list, backBtn);
    dictBar = el('div', 'dt-builtin dt-dict');
    dictBar.style.display = 'none';
    builtinBar = el('div', 'dt-builtin');
    builtinBar.style.display = 'none';
    panel.append(head, dictBar, builtinBar, wrap, emptyMsg);
    refreshBuiltinBar();
    refreshPanelSettings();
  }

  function refreshPanelSettings() {
    if (!panel) return;
    panel.classList.toggle('hide-en', settings.hideEn);
    panel.classList.toggle('hide-zh', settings.hideZh);
    panel.style.setProperty('--dt-fs', settings.panelFont + 'px');
    btns.hideEn.classList.toggle('on', settings.hideEn);
    btns.hideZh.classList.toggle('on', settings.hideZh);
    btns.follow.classList.toggle('on', settings.follow);
    panel.classList.toggle('collapsed', settings.collapsed);
    btns.toggle.textContent = settings.collapsed ? '展開逐字稿 ▼' : '收合 ▲';
    btns.toggle.title = settings.collapsed ? '打開中英對照逐字稿' : '把逐字稿面板收起來';
  }

  function ensurePanel(player) {
    const sec = document.querySelector('#secondary-inner') || document.querySelector('#secondary');
    if (!sec || location.pathname !== '/watch') { if (panel) panel.style.display = 'none'; return false; }
    if (!panel) buildPanel();
    if (panel.parentNode !== sec) sec.insertBefore(panel, sec.firstChild);
    panel.style.display = '';
    panel.style.height = settings.collapsed ? 'auto' : Math.max(400, player.clientHeight) + 'px';
    return true;
  }

  function renderList(cur) {
    if (srcLabel) {
      const src = cur === state.videoId && state.rows[0] && state.rows[0].src;
      srcLabel.textContent = src === 'dictation' ? (dict.lang.startsWith('en') ? '英文：聽寫（自動辨識，可能有錯字）' : '中文：聽寫') : src === 'human' ? '中文：人工字幕' : src === 'google' ? (trSrcText || '中文：翻譯中') : src === 'youtube' ? '中文：YouTube 翻譯' : '';
    }
    const keepScroll = lastRenderedVid === cur ? list.scrollTop : 0;
    lastRenderedVid = cur;
    list.textContent = ''; items = []; activeIdx = -1; speakRow = null; speakK = -1;
    if (cur !== state.videoId || !state.rows.length) {
      emptyMsg.style.display = '';
      emptyMsg.textContent = cur === state.videoId
        ? (dict.on ? '聽寫中，請播放影片…' : '字幕載入中…')
        : '影片開始播放後，字幕會出現在這裡。\n（影片需要有字幕或自動產生的字幕；\n若一直沒出現，請按播放器上的 CC 按鈕）';
      return;
    }
    emptyMsg.style.display = 'none';
    const frag = document.createDocumentFragment();
    let turnNo = 0;
    state.rows.forEach((r, i) => {
      if (r.turn && i > 0) turnNo++;
      const it = el('div', 'dt-item spk' + (turnNo % 2) + (r.turn && i > 0 ? ' turn' : ''));
      it.dataset.i = i;
      it.append(el('span', 'dt-time', fmt(r.start)));
      const tx = el('div', 'dt-text');
      if (r.turn && (i > 0 || r.speaker)) tx.append(el('div', 'dt-spk', r.speaker ? r.speaker : '— 換人說話 —'));
      if (r.en) tx.append(wordify(r, it));
      if (r.zh || r.pending) tx.append(el('div', 'dt-zh' + (r.pending ? ' pending' : ''), r.pending ? '翻譯中…' : r.zh));
      it.append(tx);
      frag.append(it);
      items.push(it);
    });
    list.append(frag);
    list.scrollTop = keepScroll;
    if (interimEl && dict.on) list.append(interimEl);
  }

  // 目前句子是否完整出現在面板可見範圍內
  function activeVisible() {
    const it = items[activeIdx];
    if (!it || !list.clientHeight) return true;
    const a = it.getBoundingClientRect(), b = list.getBoundingClientRect();
    return a.top >= b.top - 2 && a.bottom <= b.bottom + 2;
  }

  function scrollToActive(force) {
    const it = items[activeIdx];
    if (!it || (!settings.follow && !force)) return;
    if (!force && Date.now() - lastUserScroll < 3000) return;
    const a = it.getBoundingClientRect(), b = list.getBoundingClientRect();
    const top = list.scrollTop + (a.top - b.top) - list.clientHeight * 0.3;
    list.scrollTo({ top: Math.max(0, top), behavior: force ? 'auto' : 'smooth' });
  }

  // 定期檢查：使用者停止捲動 3 秒後，若目前句子不在畫面上就自動捲回去；
  // 自動捲動關閉、或使用者正在看別處時，顯示「回到目前句子」按鈕
  function followCheck() {
    if (!list || !items.length || activeIdx < 0) { if (backBtn) backBtn.style.display = 'none'; return; }
    const vis = activeVisible();
    if (!vis && settings.follow && Date.now() - lastUserScroll >= 3000) scrollToActive(false);
    if (backBtn) backBtn.style.display = vis ? 'none' : '';
  }

  function downloadTxt() {
    if (!state.rows.length) return;
    const title = (document.title || 'youtube').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '');
    const body = state.rows.map(r => '[' + fmt(r.start) + '] ' + (r.en || r.zh) + (r.en && r.zh ? '\n' + r.zh : '')).join('\n\n');
    const blob = new Blob(['﻿' + title + '\n' + location.href + '\n\n' + body + '\n'], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.txt';
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- 點單字查中文 ---------- */
  const dictCache = new Map();
  const ctxCache = new Map();
  const TL = CONFIG.targetLang === 'zh-Hant' ? 'zh-TW' : CONFIG.targetLang === 'zh-Hans' ? 'zh-CN' : CONFIG.targetLang;

  async function gtx(q, dts) {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' + TL +
      '&hl=zh-TW&dj=1' + dts.map(d => '&dt=' + d).join('') + '&q=' + encodeURIComponent(q);
    if (Date.now() < googleBlockedUntil) throw new Error('Google 暫時限制查詢');
    try {
      const r = await fetchRetry(url, undefined, 2);
      return r.json();
    } catch (e) {
      googleBlockedUntil = Date.now() + 5 * 60 * 1000;
      throw e;
    }
  }
  const transOf = j => ((j && j.sentences) || []).map(s => s.trans || '').join('');
  const isVerb = pos => /動詞|verb/i.test(pos || '');

  function lemmaGuesses(w) {
    const out = [];
    if (w.endsWith('ing')) { const s = w.slice(0, -3); if (/(.)\1$/.test(s)) out.push(s.slice(0, -1)); out.push(s, s + 'e'); }
    else if (w.endsWith('ied')) out.push(w.slice(0, -3) + 'y');
    else if (w.endsWith('ed')) { const s = w.slice(0, -2); if (/(.)\1$/.test(s)) out.push(s.slice(0, -1)); out.push(s, w.slice(0, -1)); }
    return [...new Set(out)].filter(x => x.length > 1);
  }

  const S2T_S = '㐷㐹㐽㑇㑈㑔㑩㓥㓰㔉㖊㖞㘎㚯㛀㛣㛤㟆㟥㡎㤘㤽㥪㧏㧐㧑㧟㧰㨫㭎㭏㭤㭴㱩㱮㲿㳔㳕㳠㳡㳽㴋㶉㶶㶽㺍㻅䀥䁖䂵䃅䅉䅟䇲䉤䌶䌷䌸䌹䌺䌻䌼䌽䌾䌿䍀䍁䍠䎬䏝䓓䓕䓖䓨䗖䙌䙓䜣䜤䜧䜩䝙䞍䞐䟢䥺䥽䥾䦂䦃䦅䦆䦶䦷䩄䯄䯅䲝䲟䲠䲡䲢䲣䴓䴔䴕䴖䴗䴘䴙䶮万与丑专业丛东丝丢两严丧个丰临为丽举么义乌乐乔习乡书买乱争于亏云亘亚产亩亲亵亸亿仅仆从仑仓仪们价众优伙会伛伞伟传伡伣伤伥伦伧伪伫体余佣佥侠侣侥侦侧侨侩侪侬侭俣俦俨俩俪俫俭债倾偬偻偾偿傤傥傧储傩儿兑兖党兰关兴兹养兽冁内冈册写军农冯冲决况冻净凄准凉减凑凛几凤凫凭凯凶击凿刍划刘则刚创删别刬刭刹刽刾刿剀剂剐剑剥剧劝办务劢动励劲劳势勋勚匀匦匮区医华协单卖占卢卤卧卫却卺厂厅历厉压厌厍厐厕厘厢厣厦厨厩厮县叁参叆叇双发变叙叠台叶号叹叽吁吃后吓吕吗吨听启吴呐呒呓呕呖呗员呙呛呜咏咙咛咝咤咨咸响哑哒哓哔哕哗哙哜哝哟唇唛唝唠唡唢唤啧啬啭啮啯啰啴啸喷喽喾嗫嗳嘘嘤嘱噜嚣团园囱围囵国图圆圣圹场坏块坚坛坜坝坞坟坠垄垅垆垒垦垩垫垭垯垱垲垴埘埙埚堑堕塆墙壮声壳壶壸处备复够头夸夹夺奁奂奋奖奥妆妇妈妩妪妫姗姹娄娅娆娇娈娱娲娴婳婴婵婶媪媭嫒嫔嫱嬷孙学孪宁宝实宠审宪宫宽宾寝对寻导寿将尔尘尝尧尴尸尽层屃屉届属屡屦屿岁岂岖岗岘岚岛岩岭岳岽岿峃峄峡峣峤峥峦峰崂崃崄崭嵘嵚嵝巅巩巯币帅师帏帐帘帜带帧帮帱帻帼幂干并广庄庆床庐庑库应庙庞废庼廪开异弃弑张弥弪弯弹强归当录彟彦彨彻征径徕忆忏忧忾怀态怂怃怄怅怆怜总怼怿恋恒恳恶恸恹恺恻恼恽悦悫悬悭悮悯惊惧惨惩惫惬惭惮惯愠愤愦愿慑慭懑懒懔戆戋戏戗战戬戯户扑托执扩扪扫扬扰抚抛抟抠抡抢护报担拟拢拣拥拦拧拨择挂挚挛挜挝挞挟挠挡挢挣挤挥挦捝捞损捡换捣据掳掴掷掸掺掼揽揾揿搀搁搂搄搅携摄摅摆摇摈摊撄撑撵撷撸撺擜擞攒敌敚敛敩数斋斓斗斩断无旧时旷旸昙昵昼昽显晋晒晓晔晕晖暂暧术朴机杀杂权杠条来杨杩杰极构枞枢枣枥枧枨枪枫枭柜柠柽栀栅标栈栉栊栋栌栎栏树栖栗样栾桠桡桢档桤桥桦桧桨桩桪梦梼梾梿检棁棂椁椝椟椠椢椤椫椭椮楼榄榅榇榈榉榝槚槛槟槠横樯樱橥橱橹橼檩欢欤欧歼殁殇残殒殓殚殡殴毁毂毕毙毡毵氇气氢氩氲汇汉汤汹沄沟没沣沤沥沦沧沨沩沪泞泪泶泷泸泺泻泼泽泾洁洒洼浃浅浆浇浈浉浊测浍济浏浐浑浒浓浔浕涂涌涚涛涝涞涟涠涡涢涣涤润涧涨涩淀渊渌渍渎渐渑渔渖渗温游湾湿溁溃溅溆溇滗滚滞滟滠满滢滤滥滦滨滩滪潆潇潋潍潜潴澛澜濑濒灏灭灯灵灶灾灿炀炉炖炜炝点炼炽烁烂烃烛烟烦烧烨烩烫烬热焕焖焘煴熏爱爷牍牦牵牺犊状犷犸犹狈狝狞独狭狮狯狰狱狲猃猎猕猡猪猫猬献獭玑玙玚玛玮环现玱玺珐珑珰珲琎琏琐琼瑶瑷瑸璎瓒瓮瓯电画畅畴疖疗疟疠疡疬疭疮疯疱疴痈痉痒痖痨痪痫痴瘅瘆瘗瘘瘪瘫瘾瘿癞癣癫皂皑皱皲盏盐监盖盗盘眍眦眬睁睐睑瞆瞒瞩矫矶矾矿砀码砖砗砚砜砺砻砾础硁硕硖硗硙硚确硵硷碍碛碜碱礼祃祎祢祯祷祸禀禄禅离秃秆种秘积称秽秾稆税稣稳穑穞穷窃窍窎窑窜窝窥窦窭竖竞笃笋笔笕笺笼笾筑筚筛筜筝筹筼签筿简箓箦箧箨箩箪箫篑篓篮篯篱簖籁籴类籼粜粝粤粪粮粽糁糇糍紧絷緼縆纟纠纡红纣纤纥约级纨纩纪纫纬纭纮纯纰纱纲纳纴纵纶纷纸纹纺纻纼纽纾线绀绁绂练组绅细织终绉绊绋绌绍绎经绐绑绒结绔绕绖绗绘给绚绛络绝绞统绠绡绢绣绤绥绦继绨绩绪绫绬续绮绯绰绱绲绳维绵绶绷绸绹绺绻综绽绾绿缀缁缂缃缄缅缆缇缈缉缊缋缌缍缎缏缐缑缒缓缔缕编缗缘缙缚缛缜缝缞缟缠缡缢缣缤缥缦缧缨缩缪缫缬缭缮缯缰缱缲缳缴缵罂网罗罚罢罴羁羟羡群翘翙翚耢耧耸耻聂聋职聍联聩聪肃肠肤肮肴肾肿胀胁胆胜胧胨胪胫胶脉脍脏脐脑脓脔脚脱脶脸腊腌腘腭腻腼腽腾膑膻臜舆舣舰舱舻艰艳艺节芈芗芜芦苁苇苈苋苌苍苎苏苧苹范茎茏茑茔茕茧荆荐荙荚荛荜荝荞荟荠荡荣荤荥荦荧荨荩荪荫荬荭荮药莅莱莲莳莴莶获莸莹莺莼萚萝萤营萦萧萨葱蒀蒇蒉蒋蒌蒏蓝蓟蓠蓣蓥蓦蔂蔷蔹蔺蔼蕰蕲蕴薮藓藴蘖虏虑虚虫虬虮虱虽虾虿蚀蚁蚂蚃蚕蚝蚬蛊蛎蛏蛮蛰蛱蛲蛳蛴蜕蜗蜡蝇蝈蝉蝎蝼蝾螀螨蟏衅衔补衬衮袄袅袆袜袭袯装裆裈裢裣裤裥褛褴襕见观觃规觅视觇览觉觊觋觌觍觎觏觐觑觞触觯訚詟誉誊讠计订讣认讥讦讧讨让讪讫讬训议讯记讱讲讳讴讵讶讷许讹论讻讼讽设访诀证诂诃评诅识诇诈诉诊诋诌词诎诏诐译诒诓诔试诖诗诘诙诚诛诜话诞诟诠诡询诣诤该详诧诨诩诪诫诬语诮误诰诱诲诳说诵诶请诸诹诺读诼诽课诿谀谁谂调谄谅谆谇谈谉谊谋谌谍谎谏谐谑谒谓谔谕谖谗谘谙谚谛谜谝谞谟谠谡谢谣谤谥谦谧谨谩谪谫谬谭谮谯谰谱谲谳谴谵谶豮贝贞负贠贡财责贤败账货质贩贪贫贬购贮贯贰贱贲贳贴贵贶贷贸费贺贻贼贽贾贿赀赁赂赃资赅赆赇赈赉赊赋赌赍赎赏赐赑赒赓赔赕赖赗赘赙赚赛赜赝赞赟赠赡赢赣赪赵赶趋趱趸跃跄跖跞践跶跷跸跹跻踌踪踬踯蹑蹒蹰蹿躏躜躯輼车轧轨轩轪轫转轭轮软轰轱轲轳轴轵轶轷轸轹轺轻轼载轾轿辀辁辂较辄辅辆辇辈辉辊辋辌辍辎辏辐辑辒输辔辕辖辗辘辙辚辞辟辩辫边辽达迁过迈运还这进远违连迟迩迳迹适选逊递逦逻遗遥邓邝邬邮邹邺邻郁郏郐郑郓郦郧郸酂酝酦酱酽酾酿醖采释里鉴銮錾钅钆钇针钉钊钋钌钍钎钏钐钑钒钓钔钕钖钗钘钙钚钛钜钝钞钟钠钡钢钣钤钥钦钧钨钩钪钫钬钭钮钯钰钱钲钳钴钵钶钷钸钹钺钻钼钽钾钿铀铁铂铃铄铅铆铇铈铉铊铋铌铍铎铏铐铑铒铓铔铕铖铗铘铙铚铛铜铝铞铟铠铡铢铣铤铥铦铧铨铩铪铫铬铭铮铯铰铱铲铳铴铵银铷铸铹铺铻铼铽链铿销锁锂锃锄锅锆锇锈锉锊锋锌锍锎锏锐锑锒锓锔锕锖锗锘错锚锛锜锝锞锟锠锡锢锣锤锥锦锧锨锩锪锫锬锭键锯锰锱锲锳锴锵锶锷锸锹锺锻锼锽锾锿镀镁镂镃镄镅镆镇镈镉镊镋镌镍镎镏镐镑镒镓镔镕镖镗镘镙镚镛镜镝镞镟镠镡镢镣镤镥镦镧镨镩镪镫镬镭镮镯镰镱镲镳镴镵镶长门闩闪闫闬闭问闯闰闱闲闳间闵闶闷闸闹闺闻闼闽闾闿阀阁阂阃阄阅阆阇阈阉阊阋阌阍阎阏阐阑阒阓阔阕阖阗阘阙阚阛队阳阴阵阶际陆陇陈陉陕陦陧陨险随隐隶隽难雇雏雠雳雾霁霉霡霭靓靔静靥鞑鞒鞯鞲韦韧韨韩韪韫韬韵页顶顷顸项顺须顼顽顾顿颀颁颂颃预颅领颇颈颉颊颋颌颍颎颏颐频颒颓颔颕颖颗题颙颚颛颜额颞颟颠颡颢颣颤颥颦颧风飏飐飑飒飓飔飕飖飗飘飙飚飞飨餍饣饤饥饦饧饨饩饪饫饬饭饮饯饰饱饲饳饴饵饶饷饸饹饺饻饼饽饾饿馀馁馂馃馄馅馆馇馈馉馊馋馌馍馎馏馐馑馒馓馔馕马驭驮驯驰驱驲驳驴驵驶驷驸驹驺驻驼驽驾驿骀骁骂骃骄骅骆骇骈骉骊骋验骍骎骏骐骑骒骓骔骕骖骗骘骙骚骛骜骝骞骟骠骡骢骣骤骥骦骧髅髋髌鬓鬶魇魉鱼鱽鱾鱿鲀鲁鲂鲃鲄鲅鲆鲇鲈鲉鲊鲋鲌鲍鲎鲏鲐鲑鲒鲓鲔鲕鲖鲗鲘鲙鲚鲛鲜鲝鲞鲟鲠鲡鲢鲣鲤鲥鲦鲧鲨鲩鲪鲫鲬鲭鲮鲯鲰鲱鲲鲳鲴鲵鲶鲷鲸鲹鲺鲻鲼鲽鲾鲿鳀鳁鳂鳃鳄鳅鳆鳇鳈鳉鳊鳋鳌鳍鳎鳏鳐鳑鳒鳓鳔鳕鳖鳗鳘鳙鳚鳛鳜鳝鳞鳟鳠鳡鳢鳣鳤鸟鸠鸡鸢鸣鸤鸥鸦鸧鸨鸩鸪鸫鸬鸭鸮鸯鸰鸱鸲鸳鸴鸵鸶鸷鸸鸹鸺鸻鸼鸽鸾鸿鹀鹁鹂鹃鹄鹅鹆鹇鹈鹉鹊鹋鹌鹍鹎鹏鹐鹑鹒鹓鹔鹕鹖鹗鹘鹙鹚鹛鹜鹝鹞鹟鹠鹡鹢鹣鹤鹥鹦鹧鹨鹩鹪鹫鹬鹭鹮鹯鹰鹱鹲鹳鹴鹾麦麸麹麺麽黄黉黡黩黪黾鼋鼌鼍鼹齐齑齿龀龁龂龃龄龅龆龇龈龉龊龋龌龙龚龛龟鿎鿏鿒鿔';
  const S2T_T = '傌㑶偑㑳倲㑯儸劏劃劚噚喎㘚㜄媰㜏孋㠏嵾幓㥮懤慺掆㩳撝擓擽㩜棡椲樢樫殰殨瀇濧灡澾濄瀰潚鸂燶煱獱璯䁻瞜碽磾稏穇筴籔䊷紬縳絅䋙䋚綐綵䋻䋹繿繸䍦䎱膞薵薳藭罃螮䙡襬訢鿁䜀讌貙䝼賰躎釾鏺䥱䥇鐯鐥钁䦛䦟靦騧䯀䱽鮣鰆鰌鰧䱷鳾鵁鴷鶄鶪鷉鸊龑萬與醜專業叢東絲丟兩嚴喪個豐臨爲麗舉麼義烏樂喬習鄉書買亂爭於虧雲亙亞產畝親褻嚲億僅僕從侖倉儀們價衆優夥會傴傘偉傳俥俔傷倀倫傖僞佇體餘傭僉俠侶僥偵側僑儈儕儂儘俁儔儼倆儷倈儉債傾傯僂僨償儎儻儐儲儺兒兌兗黨蘭關興茲養獸囅內岡冊寫軍農馮衝決況凍淨悽準涼減湊凜幾鳳鳧憑凱兇擊鑿芻劃劉則剛創刪別剗剄剎劊㓨劌剴劑剮劍剝劇勸辦務勱動勵勁勞勢勳勩勻匭匱區醫華協單賣佔盧滷臥衛卻巹廠廳歷厲壓厭厙龎廁釐廂厴廈廚廄廝縣叄參靉靆雙發變敘疊臺葉號嘆嘰籲喫後嚇呂嗎噸聽啓吳吶嘸囈嘔嚦唄員咼嗆嗚詠嚨嚀噝吒諮鹹響啞噠嘵嗶噦譁噲嚌噥喲脣嘜嗊嘮啢嗩喚嘖嗇囀齧嘓囉嘽嘯噴嘍嚳囁噯噓嚶囑嚕囂團園囪圍圇國圖圓聖壙場壞塊堅壇壢壩塢墳墜壟壠壚壘墾堊墊埡墶壋塏堖塒壎堝塹墮壪牆壯聲殼壺壼處備復夠頭誇夾奪奩奐奮獎奧妝婦媽嫵嫗嬀姍奼婁婭嬈嬌孌娛媧嫺嫿嬰嬋嬸媼嬃嬡嬪嬙嬤孫學孿寧寶實寵審憲宮寬賓寢對尋導壽將爾塵嘗堯尷屍盡層屓屜屆屬屢屨嶼歲豈嶇崗峴嵐島巖嶺嶽崬巋嶨嶧峽嶢嶠崢巒峯嶗崍嶮嶄嶸嶔嶁巔鞏巰幣帥師幃帳簾幟帶幀幫幬幘幗冪幹並廣莊慶牀廬廡庫應廟龐廢廎廩開異棄弒張彌弳彎彈強歸當錄彠彥彲徹徵徑徠憶懺憂愾懷態慫憮慪悵愴憐總懟懌戀恆懇惡慟懨愷惻惱惲悅愨懸慳悞憫驚懼慘懲憊愜慚憚慣慍憤憒願懾憖懣懶懍戇戔戲戧戰戩戱戶撲託執擴捫掃揚擾撫拋摶摳掄搶護報擔擬攏揀擁攔擰撥擇掛摯攣掗撾撻挾撓擋撟掙擠揮撏挩撈損撿換搗據擄摑擲撣摻摜攬搵撳攙擱摟揯攪攜攝攄擺搖擯攤攖撐攆擷擼攛㩵擻攢敵敓斂斆數齋斕鬥斬斷無舊時曠暘曇暱晝曨顯晉曬曉曄暈暉暫曖術樸機殺雜權槓條來楊榪傑極構樅樞棗櫪梘棖槍楓梟櫃檸檉梔柵標棧櫛櫳棟櫨櫟欄樹棲慄樣欒椏橈楨檔榿橋樺檜槳樁樳夢檮棶槤檢梲欞槨槼櫝槧槶欏樿橢槮樓欖榲櫬櫚櫸樧檟檻檳櫧橫檣櫻櫫櫥櫓櫞檁歡歟歐殲歿殤殘殞殮殫殯毆毀轂畢斃氈毿氌氣氫氬氳匯漢湯洶澐溝沒灃漚瀝淪滄渢潙滬濘淚澩瀧瀘濼瀉潑澤涇潔灑窪浹淺漿澆湞溮濁測澮濟瀏滻渾滸濃潯濜塗湧涗濤澇淶漣潿渦溳渙滌潤澗漲澀澱淵淥漬瀆漸澠漁瀋滲溫遊灣溼濚潰濺漵漊潷滾滯灩灄滿瀅濾濫灤濱灘澦瀠瀟瀲濰潛瀦瀂瀾瀨瀕灝滅燈靈竈災燦煬爐燉煒熗點煉熾爍爛烴燭煙煩燒燁燴燙燼熱煥燜燾熅燻愛爺牘犛牽犧犢狀獷獁猶狽獮獰獨狹獅獪猙獄猻獫獵獼玀豬貓蝟獻獺璣璵瑒瑪瑋環現瑲璽琺瓏璫琿璡璉瑣瓊瑤璦璸瓔瓚甕甌電畫暢疇癤療瘧癘瘍癧瘲瘡瘋皰痾癰痙癢瘂癆瘓癇癡癉瘮瘞瘻癟癱癮癭癩癬癲皁皚皺皸盞鹽監蓋盜盤瞘眥矓睜睞瞼瞶瞞矚矯磯礬礦碭碼磚硨硯碸礪礱礫礎硜碩硤磽磑礄確磠礆礙磧磣鹼禮禡禕禰禎禱禍稟祿禪離禿稈種祕積稱穢穠穭稅穌穩穡穭窮竊竅窵窯竄窩窺竇窶豎競篤筍筆筧箋籠籩築篳篩簹箏籌篔籤篠簡籙簀篋籜籮簞簫簣簍籃籛籬籪籟糴類秈糶糲粵糞糧糉糝餱餈緊縶縕緪糹糾紆紅紂纖紇約級紈纊紀紉緯紜紘純紕紗綱納紝縱綸紛紙紋紡紵紖紐紓線紺紲紱練組紳細織終縐絆紼絀紹繹經紿綁絨結絝繞絰絎繪給絢絳絡絕絞統綆綃絹繡綌綏絛繼綈績緒綾緓續綺緋綽鞝緄繩維綿綬繃綢綯綹綣綜綻綰綠綴緇緙緗緘緬纜緹緲緝縕繢緦綞緞緶線緱縋緩締縷編緡緣縉縛縟縝縫縗縞纏縭縊縑繽縹縵縲纓縮繆繅纈繚繕繒繮繾繰繯繳纘罌網羅罰罷羆羈羥羨羣翹翽翬耮耬聳恥聶聾職聹聯聵聰肅腸膚骯餚腎腫脹脅膽勝朧腖臚脛膠脈膾髒臍腦膿臠腳脫腡臉臘醃膕齶膩靦膃騰臏羶臢輿艤艦艙艫艱豔藝節羋薌蕪蘆蓯葦藶莧萇蒼苧蘇薴蘋範莖蘢蔦塋煢繭荊薦薘莢蕘蓽萴蕎薈薺蕩榮葷滎犖熒蕁藎蓀蔭蕒葒葤藥蒞萊蓮蒔萵薟獲蕕瑩鶯蓴蘀蘿螢營縈蕭薩蔥蒕蕆蕢蔣蔞醟藍薊蘺蕷鎣驀虆薔蘞藺藹薀蘄蘊藪蘚蘊櫱虜慮虛蟲虯蟣蝨雖蝦蠆蝕蟻螞蠁蠶蠔蜆蠱蠣蟶蠻蟄蛺蟯螄蠐蛻蝸蠟蠅蟈蟬蠍螻蠑螿蟎蠨釁銜補襯袞襖嫋褘襪襲襏裝襠褌褳襝褲襉褸襤襴見觀覎規覓視覘覽覺覬覡覿覥覦覯覲覷觴觸觶誾讋譽謄訁計訂訃認譏訐訌討讓訕訖託訓議訊記訒講諱謳詎訝訥許訛論訩訟諷設訪訣證詁訶評詛識詗詐訴診詆謅詞詘詔詖譯詒誆誄試詿詩詰詼誠誅詵話誕詬詮詭詢詣諍該詳詫諢詡譸誡誣語誚誤誥誘誨誑說誦誒請諸諏諾讀諑誹課諉諛誰諗調諂諒諄誶談讅誼謀諶諜謊諫諧謔謁謂諤諭諼讒諮諳諺諦謎諞諝謨讜謖謝謠謗諡謙謐謹謾謫譾謬譚譖譙讕譜譎讞譴譫讖豶貝貞負貟貢財責賢敗賬貨質販貪貧貶購貯貫貳賤賁貰貼貴貺貸貿費賀貽賊贄賈賄貲賃賂贓資賅贐賕賑賚賒賦賭齎贖賞賜贔賙賡賠賧賴賵贅賻賺賽賾贗贊贇贈贍贏贛赬趙趕趨趲躉躍蹌蹠躒踐躂蹺蹕躚躋躊蹤躓躑躡蹣躕躥躪躦軀轀車軋軌軒軑軔轉軛輪軟轟軲軻轤軸軹軼軤軫轢軺輕軾載輊轎輈輇輅較輒輔輛輦輩輝輥輞輬輟輜輳輻輯轀輸轡轅轄輾轆轍轔辭闢辯辮邊遼達遷過邁運還這進遠違連遲邇逕跡適選遜遞邐邏遺遙鄧鄺鄔郵鄒鄴鄰鬱郟鄶鄭鄆酈鄖鄲酇醞醱醬釅釃釀醞採釋裏鑑鑾鏨釒釓釔針釘釗釙釕釷釺釧釤鈒釩釣鍆釹鍚釵鈃鈣鈈鈦鉅鈍鈔鍾鈉鋇鋼鈑鈐鑰欽鈞鎢鉤鈧鈁鈥鈄鈕鈀鈺錢鉦鉗鈷鉢鈳鉕鈽鈸鉞鑽鉬鉭鉀鈿鈾鐵鉑鈴鑠鉛鉚鉋鈰鉉鉈鉍鈮鈹鐸鉶銬銠鉺鋩錏銪鋮鋏鋣鐃銍鐺銅鋁銱銦鎧鍘銖銑鋌銩銛鏵銓鎩鉿銚鉻銘錚銫鉸銥鏟銃鐋銨銀銣鑄鐒鋪鋙錸鋱鏈鏗銷鎖鋰鋥鋤鍋鋯鋨鏽銼鋝鋒鋅鋶鐦鐧銳銻鋃鋟鋦錒錆鍺鍩錯錨錛錡鍀錁錕錩錫錮鑼錘錐錦鑕鍁錈鍃錇錟錠鍵鋸錳錙鍥鍈鍇鏘鍶鍔鍤鍬鍾鍛鎪鍠鍰鎄鍍鎂鏤鎡鐨鎇鏌鎮鎛鎘鑷钂鐫鎳鎿鎦鎬鎊鎰鎵鑌鎔鏢鏜鏝鏍鏰鏞鏡鏑鏃鏇鏐鐔钁鐐鏷鑥鐓鑭鐠鑹鏹鐙鑊鐳鐶鐲鐮鐿鑔鑣鑞鑱鑲長門閂閃閆閈閉問闖閏闈閒閎間閔閌悶閘鬧閨聞闥閩閭闓閥閣閡閫鬮閱閬闍閾閹閶鬩閿閽閻閼闡闌闃闠闊闋闔闐闒闕闞闤隊陽陰陣階際陸隴陳陘陝隯隉隕險隨隱隸雋難僱雛讎靂霧霽黴霢靄靚靝靜靨韃鞽韉韝韋韌韍韓韙韞韜韻頁頂頃頇項順須頊頑顧頓頎頒頌頏預顱領頗頸頡頰頲頜潁熲頦頤頻頮頹頷頴穎顆題顒顎顓顏額顳顢顛顙顥纇顫顬顰顴風颺颭颮颯颶颸颼颻飀飄飆飈飛饗饜飠飣飢飥餳飩餼飪飫飭飯飲餞飾飽飼飿飴餌饒餉餄餎餃餏餅餑餖餓餘餒餕餜餛餡館餷饋餶餿饞饁饃餺餾饈饉饅饊饌饢馬馭馱馴馳驅馹駁驢駔駛駟駙駒騶駐駝駑駕驛駘驍罵駰驕驊駱駭駢驫驪騁驗騂駸駿騏騎騍騅騌驌驂騙騭騤騷騖驁騮騫騸驃騾驄驏驟驥驦驤髏髖髕鬢鬹魘魎魚魛魢魷魨魯魴䰾魺鮁鮃鮎鱸鮋鮓鮒鮊鮑鱟鮍鮐鮭鮚鮳鮪鮞鮦鰂鮜鱠鱭鮫鮮鮺鯗鱘鯁鱺鰱鰹鯉鰣鰷鯀鯊鯇鮶鯽鯒鯖鯪鯕鯫鯡鯤鯧鯝鯢鯰鯛鯨鰺鯴鯔鱝鰈鰏鱨鯷鰮鰃鰓鱷鰍鰒鰉鰁鱂鯿鰠鰲鰭鰨鰥鰩鰟鰜鰳鰾鱈鱉鰻鰵鱅䲁鰼鱖鱔鱗鱒鱯鱤鱧鱣䲘鳥鳩雞鳶鳴鳲鷗鴉鶬鴇鴆鴣鶇鸕鴨鴞鴦鴒鴟鴝鴛鷽鴕鷥鷙鴯鴰鵂鴴鵃鴿鸞鴻鵐鵓鸝鵑鵠鵝鵒鷳鵜鵡鵲鶓鵪鵾鵯鵬鵮鶉鶊鵷鷫鶘鶡鶚鶻鶖鷀鶥鶩鷊鷂鶲鶹鶺鷁鶼鶴鷖鸚鷓鷚鷯鷦鷲鷸鷺䴉鸇鷹鸌鸏鸛鸘鹺麥麩麴麪麼黃黌黶黷黲黽黿鼂鼉鼴齊齏齒齔齕齗齟齡齙齠齜齦齬齪齲齷龍龔龕龜䃮䥑鿓鎶';
  let S2T = null, T2S = null;
  function s2tMaps() {
    if (S2T) return;
    S2T = new Map(); T2S = new Map();
    for (let i = 0; i < S2T_S.length; i++) { S2T.set(S2T_S[i], S2T_T[i]); if (!T2S.has(S2T_T[i])) T2S.set(S2T_T[i], S2T_S[i]); }
  }
  const toTrad = w => { s2tMaps(); return Array.from(w).map(c => S2T.get(c) || c).join(''); };
  const toSimp = w => { s2tMaps(); return Array.from(w).map(c => T2S.get(c) || c).join(''); };

  // 最常見的意思：繁中字典沒有常用度分數，所以借用簡中字典的分數排序，再逐字轉成繁體
  async function commonMeanings(key, twTerms) {
    if (!TL.startsWith('zh') || Date.now() < googleBlockedUntil) return [];
    const r = await fetchRetry('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&hl=zh-TW&dt=bd&dj=1&q=' + encodeURIComponent(key), undefined, 2);
    const j = await r.json();
    const all = [];
    ((j && j.dict) || []).forEach(d => (d.entry || []).forEach(e => { if (e.word) all.push({ pos: d.pos, w: e.word, s: e.score || 0 }); }));
    all.sort((a, b) => b.s - a.s);
    const out = [], seen = new Set();
    all.forEach(x => {
      const term = TL === 'zh-CN' ? x.w : (twTerms.find(t => toSimp(t) === x.w) || toTrad(x.w));
      if (!seen.has(term)) { seen.add(term); out.push({ pos: x.pos, term, score: x.s }); }
    });
    return out;
  }

  function lookupWord(word) {
    const key = word.toLowerCase();
    if (dictCache.has(key)) return dictCache.get(key);
    const p = (async () => {
      const j = await gtx(key, ['t', 'bd']);
      let groups = ((j && j.dict) || []).map(d => ({
        pos: d.pos, base: d.base_form || key,
        terms: ((d.entry || []).map(e => e.word)).concat(d.terms || []).filter((x, i, a) => x && a.indexOf(x) === i),
      }));
      // -ing / -ed 變化形：字典沒給動詞意思時，補查原形（running → run）
      if (/(ing|ed)$/.test(key) && !groups.some(g => isVerb(g.pos))) {
        for (const b of lemmaGuesses(key)) {
          try {
            const j2 = await gtx(b, ['bd']);
            const g2 = ((j2 && j2.dict) || []).filter(d => isVerb(d.pos)).map(d => ({
              pos: d.pos, base: d.base_form || b, terms: (d.entry || []).map(e => e.word).filter(Boolean),
            }));
            if (g2.length) { groups = groups.concat(g2); break; }
          } catch (e) {}
        }
      }
      let common = [];
      try { common = await commonMeanings(key, [].concat(...groups.map(g => g.terms))); } catch (e) {}
      if (!common.length) {   // 備案：繁中字典各詞性的前幾個
        const seen = new Set();
        groups.forEach(g => g.terms.slice(0, 2).forEach(t => { if (!seen.has(t)) { seen.add(t); common.push({ pos: g.pos, term: t, score: 0 }); } }));
      }
      // 常見意思也加入「依句意比對」的候選
      const extra = {};
      common.forEach(c => { if (!groups.some(g => g.pos === c.pos && g.terms.includes(c.term))) (extra[c.pos] = extra[c.pos] || []).push(c.term); });
      Object.keys(extra).forEach(pos => groups.push({ pos, base: key, terms: extra[pos] }));
      return { word: key, main: transOf(j), groups, common };
    })();
    dictCache.set(key, p);
    p.catch(() => dictCache.delete(key));
    return p;
  }

  function cachedTrans(q) {
    if (!q) return Promise.resolve('');
    if (!ctxCache.has(q)) ctxCache.set(q, gtx(q, ['t']).then(transOf).catch(() => { ctxCache.delete(q); return ''; }));
    return ctxCache.get(q);
  }

  // 最長共同子字串：回傳長度與在 b 裡的位置
  function lcs(a, b) {
    let best = 0, pos = -1;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) { best = k; pos = j; }
    }
    return { len: best, pos };
  }

  // 從字典解釋裡，挑出最符合這一句中文翻譯的那一個
  const STOP_CHARS = '的了是在一不有人我他她它你這那個們之和與為地得著也就都而及或把被對到上下中大小來去說要會能可以';
  function pickContextual(groups, ctx, common) {
    const rank = new Map((common || []).map((c, i) => [c.term, i]));
    let best = null;
    groups.forEach((g, gi) => g.terms.forEach((term, ti) => {
      const core = term.replace(/[()（）.…]/g, '');
      const m = lcs(core, ctx);
      if (m.len < 1) return;
      let weak = 0;
      if (m.len === 1 && core.length > 1) {
        // 只有一個字相同：字詞不能太長，且相同的字不能是常見虛字
        if (core.length > 3 || STOP_CHARS.includes(ctx[m.pos])) return;
        weak = 0.35;
      }
      const r = rank.has(term) ? rank.get(term) : 99;
      const score = m.len / core.length + m.len * 0.3 - weak - ti * 0.01 - gi * 0.005 + (r < 99 ? 0.2 - r * 0.02 : 0);
      if (!best || score > best.score) best = { score, term, pos: g.pos, base: g.base, gi, ti };
    }));
    return best;
  }

  /* ---------- 音標（Free Dictionary API）＋ 真人發音（維基共享資源） ---------- */
  const phonCache = new Map();
  function getPhon(word) {
    if (!phonCache.has(word)) phonCache.set(word, (async () => {
      const r = await nativeFetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
      if (!r.ok) return null;
      const j = await r.json();
      const res = { us: null, uk: null, any: null, defs: [] };
      (Array.isArray(j) ? j : []).forEach(e => {
        (e.phonetics || []).forEach(p => {
          const a = p.audio || '';
          if (/-us\.mp3$/.test(a) && p.text && !res.us) res.us = p.text;
          else if (/-uk\.mp3$/.test(a) && p.text && !res.uk) res.uk = p.text;
          if (p.text && !res.any) res.any = p.text;
        });
        if (e.phonetic && !res.any) res.any = e.phonetic;
        (e.meanings || []).forEach(m => (m.definitions || []).slice(0, 1).forEach(d => {
          if (res.defs.length < 3 && d.definition) res.defs.push({ pos: m.partOfSpeech, def: d.definition });
        }));
      });
      return (res.us || res.uk || res.any || res.defs.length) ? res : null;
    })().catch(() => null));
    return phonCache.get(word);
  }

  let audioCtx = null;
  const audioCache = new Map();
  async function playCommons(file) {
    let p = audioCache.get(file);
    if (!p) {
      p = (async () => {
        const api = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url&titles=File:' + encodeURIComponent(file);
        const j = await (await nativeFetch(api)).json();
        const pg = Object.values((j.query && j.query.pages) || {})[0];
        const url = pg && pg.imageinfo && pg.imageinfo[0] && pg.imageinfo[0].url;
        if (!url) return null;
        const buf = await (await nativeFetch(url)).arrayBuffer();
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        return await audioCtx.decodeAudioData(buf);
      })();
      audioCache.set(file, p);
      p.catch(() => audioCache.delete(file));
    }
    const ab = await p;
    if (!ab) return false;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const s = audioCtx.createBufferSource();
    s.buffer = ab; s.connect(audioCtx.destination); s.start();
    return true;
  }
  async function playWord(word, accent) {
    try { if (await playCommons('En-' + accent + '-' + word + '.ogg')) return; } catch (e) {}
    speak(word, accent === 'uk' ? 'en-GB' : 'en-US');   // 找不到真人錄音 → 電腦語音
  }

  const CAMBRIDGE = 'https://dictionary.cambridge.org/zht/%E8%A9%9E%E5%85%B8/%E8%8B%B1%E8%AA%9E-%E6%BC%A2%E8%AA%9E-%E7%B9%81%E9%AB%94/';

  function renderMeta(meta, word, base) {
    meta.textContent = '';
    const a = el('a', 'dp-link', '劍橋字典 ↗');
    a.href = CAMBRIDGE + encodeURIComponent(base || word);
    a.target = '_blank'; a.rel = 'noopener';
    a.title = '打開劍橋英漢字典（看例句、詳細用法）';
    meta.append(a);
  }

  function renderPhon(box, word, ph) {
    box.textContent = '';
    const add = (label, ipa, accent) => {
      const s = el('span', 'dp-ph');
      if (label) s.append(el('span', 'dp-acc', label));
      s.append(document.createTextNode(ipa || ''));
      if (ipa) box.append(s);
    };
    if (ph && (ph.us || ph.uk)) {
      if (ph.us) add('美', ph.us, 'us');
      if (ph.uk) add('英', ph.uk, 'uk');
    } else add('', ph && ph.any, 'us');
  }

  let pop = null, popWord = null, pausedByPop = false, popToken = 0;

  function closePop() {
    if (!pop) return;
    pop.remove(); pop = null;
    if (popWord) popWord.classList.remove('sel');
    popWord = null;
    const v = getVideo();
    if (pausedByPop && v && v.paused) v.play();
    pausedByPop = false;
  }

  function placePop(anchor) {
    if (!pop || !anchor.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function speak(word, lang) {
    try {
      const u = new SpeechSynthesisUtterance(word);
      u.lang = lang || 'en-US'; u.rate = 0.85;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }

  function sentWithMark(text, term) {
    const box = el('div', 'dp-sent');
    const m = term ? lcs(term, text) : { len: 0 };
    if (m.len >= (term && term.length === 1 ? 1 : 2)) {
      box.append(document.createTextNode(text.slice(0, m.pos)));
      box.append(el('mark', null, text.slice(m.pos, m.pos + m.len)));
      box.append(document.createTextNode(text.slice(m.pos + m.len)));
    } else box.textContent = text;
    return box;
  }

  /* ---------- 離線英漢字典 ECDICT（MIT 授權，https://github.com/skywind3000/ECDICT），轉成台灣繁體 ---------- */
  const DICT_URLS = [
    'https://cdn.jsdelivr.net/gh/oohya330-glitch/youtube-dual-subs@main/dict/',
    'https://raw.githubusercontent.com/oohya330-glitch/youtube-dual-subs/main/dict/',
  ];
  const dictFiles = new Map();
  function dictFile(letter) {
    if (!dictFiles.has(letter)) {
      const p = (async () => {
        for (const base of DICT_URLS) {
          try { const r = await nativeFetch(base + letter + '.json'); if (r.ok) return await r.json(); } catch (e) {}
        }
        throw new Error('字典檔下載失敗');
      })();
      dictFiles.set(letter, p);
      p.catch(() => dictFiles.delete(letter));
    }
    return dictFiles.get(letter);
  }
  const POS_NAME = { 'n.': '名詞', 'v.': '動詞', 'vt.': '及物動詞', 'vi.': '不及物動詞', 'a.': '形容詞', 'adj.': '形容詞',
    'ad.': '副詞', 'adv.': '副詞', 'prep.': '介系詞', 'conj.': '連接詞', 'pron.': '代名詞', 'int.': '感嘆詞', 'interj.': '感嘆詞',
    'num.': '數詞', 'art.': '冠詞', 'aux.': '助動詞', 'abbr.': '縮寫', 'pl.': '複數' };
  const posName = p => POS_NAME[p] || POS_NAME[(p || '').split(/\s|&/)[0]] || (p || '');
  async function ecdictGet(w) {
    const k = w[0];
    if (!/[a-z]/.test(k || '')) return null;
    const f = await dictFile(k);
    if (f.w && f.w[w]) return { w, e: f.w[w] };
    if (f.f && f.f[w]) { const l = f.f[w]; const f2 = await dictFile(l[0]); return f2.w && f2.w[l] ? { w: l, e: f2.w[l], from: w } : null; }
    return null;
  }
  // 回傳與 Google 字典相同的格式，讓「依句意挑意思」共用
  async function ecdictLookup(word) {
    const w = word.toLowerCase();
    const hit = await ecdictGet(w);
    if (!hit) return null;
    let lemma = hit.from ? hit.w : (hit.e.l || null);
    const groups = (hit.e.t || []).map(([p, terms]) => ({ pos: posName(p), base: lemma || w, terms: terms.slice() }));
    let phon = hit.e.p || '';
    if (lemma && !hit.from) {   // 例如 running：本身有解釋，再加上原形 run 的意思
      const lh = await ecdictGet(lemma).catch(() => null);
      if (lh) (lh.e.t || []).forEach(([p, terms]) => groups.push({ pos: posName(p), base: lemma, terms: terms.slice() }));
    }
    if (!groups.length) return null;
    // 常見程度：各詞性的第一個意思最常用，依序往後
    const common = [], seen = new Set();
    const maxT = Math.max(...groups.map(g => g.terms.length));
    for (let ti = 0; ti < maxT; ti++) groups.forEach(g => { const t = g.terms[ti]; if (t && !seen.has(t)) { seen.add(t); common.push({ pos: g.pos, term: t }); } });
    return { word: w, main: groups[0].terms[0], groups, common, phon: phon.replace(/ә/g, 'ə'), lemma: lemma !== w ? lemma : null, src: 'ecdict' };
  }

  async function showWord(span, row) {
    const word = span.textContent.replace(/[’']s$/i, '').replace(/[’']/g, "'");
    if (popWord === span) { closePop(); return; }
    closePop();
    const v = getVideo();
    if (v && !v.paused) { v.pause(); pausedByPop = true; }
    popWord = span; span.classList.add('sel');
    pop = el('div'); pop.id = 'dt-pop';
    pop.addEventListener('mousedown', e => e.stopPropagation());
    const head = el('div', 'dp-head');
    head.append(el('span', 'dp-word', word));
    const x = el('button', 'dp-ico dp-x', '✕'); x.title = '關閉';
    x.addEventListener('click', closePop);
    head.append(x);
    const lw = word.toLowerCase();
    const phon = el('div', 'dp-phon');
    renderPhon(phon, lw, null);
    const meta = el('div', 'dp-meta');
    renderMeta(meta, lw, null);
    const body = el('div', 'dp-body', '查詢中…');
    pop.append(head, phon, meta, body);
    getPhon(lw).then(ph => {
      if (ph) { if (pop && popWord === span) { renderPhon(phon, lw, ph); placePop(span); } return; }
      return ecdictLookup(lw).then(d => {
        const b = d && d.lemma;
        return b ? getPhon(b) : null;
      }).then(ph2 => { if (ph2 && pop && popWord === span) { renderPhon(phon, lw, ph2); placePop(span); } });
    }).catch(() => {});
    document.body.append(pop);
    placePop(span);
    const token = ++popToken;

    try {
      // 句子附近幾個字的翻譯，幫助判斷這個字在句中的意思
      const words = (row.en || '').split(/\s+/);
      const wi = Array.from(span.closest('.dt-en').querySelectorAll('.dt-w')).indexOf(span);
      const near = words.length > 6 && wi >= 0 ? words.slice(Math.max(0, wi - 3), wi + 4).join(' ') : '';
      let lookErr = '';
      let d = await ecdictLookup(word).catch(e => { lookErr = e.message; return null; });
      if (d && d.phon && token === popToken && pop) { renderPhon(phon, lw, { any: '/' + d.phon + '/' }); }
      if (!d) d = await lookupWord(word).catch(e => { lookErr = lookErr || e.message; return null; });
      if (token !== popToken || !pop) return;
      if (!d) {   // 字典查不到：至少顯示這一句的中文
        body.textContent = '';
        const box = el('div', 'dp-ctx dp-ctx-guess');
        box.append(el('div', 'dp-label', '字典裡查不到這個字' + (lookErr ? '（' + lookErr + '）' : '')));
        if (row.zh) box.append(el('div', 'dp-sent', '這句的中文：' + row.zh));
        body.append(box);
        if (builtin.tr) {     // 用瀏覽器內建翻譯，至少給出單字和附近幾個字的中文
          try {
            const [wT, nT] = await Promise.all([builtin.tr.translate(word), near ? builtin.tr.translate(near) : Promise.resolve('')]);
            if (token !== popToken || !pop) return;
            box.firstChild.textContent = '中文（瀏覽器內建翻譯）';
            box.insertBefore(el('div', 'dp-main', wT.trim()), box.children[1] || null);
            if (nT) box.append(el('div', 'dp-sent', '這幾個字在句中的翻譯：' + nT.trim()));
          } catch (e) {}
        }
        const ph = await getPhon(word.toLowerCase());
        if (token !== popToken || !pop) return;
        if (ph && ph.defs.length) {
          body.append(el('div', 'dp-label dp-label2', '英英解釋'));
          ph.defs.forEach(x => { const line = el('div', 'dp-other'); line.append(el('span', 'dp-pos', x.pos), document.createTextNode(x.def)); body.append(line); });
        }
        placePop(span);
        return;
      }
      // 先用這一列已有的中文翻譯判斷；判斷不出來才另外查「附近幾個字」的翻譯（減少查詢次數）
      let best = pickContextual(d.groups, row.zh || '', d.common);
      let nearT = '';
      if (!best) {
        const sentT = row.zh ? '' : await cachedTrans(row.en);
        if (near && builtin.tr) { try { nearT = (await builtin.tr.translate(near)).trim(); } catch (e) {} }
        if (!nearT) nearT = await cachedTrans(near);
        if (token !== popToken || !pop) return;
        best = pickContextual(d.groups, [row.zh, sentT, nearT].filter(Boolean).join('｜'), d.common);
      }
      body.textContent = '';

      const base = d.lemma ? { base: d.lemma } : d.groups.find(g => g.base && g.base !== d.word);
      if (base) body.append(el('div', 'dp-base', '原形：' + base.base));
      renderMeta(meta, d.word, base && base.base);

      const box = el('div', 'dp-ctx');
      if (best) {
        box.append(el('div', 'dp-label', '✔ 這句裡的意思'));
        const line = el('div', 'dp-main');
        line.append(el('span', 'dp-pos', best.pos), document.createTextNode(best.term));
        box.append(line);
        if (row.zh) box.append(sentWithMark(row.zh, best.term));
      } else {
        box.classList.add('dp-ctx-guess');
        box.append(el('div', 'dp-label', '最常見的意思（無法從句子判斷）'));
        box.append(el('div', 'dp-main', d.main || '—'));
        if (nearT) box.append(el('div', 'dp-sent', '這幾個字在句中的翻譯：' + nearT));
        else if (row.zh) box.append(el('div', 'dp-sent', row.zh));
      }
      body.append(box);

      // 其他常見意思：只列最常見的 3 個（依常用程度排序，同詞性放同一行）
      const shown = best ? best.term : (d.main || '');
      const top = (d.common || []).filter(c => c.term !== shown).slice(0, 3);
      if (top.length) {
        body.append(el('div', 'dp-label dp-label2', '其他常見意思'));
        const byPos = [];
        top.forEach(c => { let g = byPos.find(x => x.pos === c.pos); if (!g) byPos.push(g = { pos: c.pos, terms: [] }); g.terms.push(c.term); });
        byPos.forEach(g => {
          const line = el('div', 'dp-other');
          line.append(el('span', 'dp-pos', g.pos), document.createTextNode(g.terms.join('、')));
          body.append(line);
        });
      }
      if (d.src === 'ecdict') body.append(el('div', 'dp-credit', '字典：ECDICT（開源英漢字典）'));
      placePop(span);
    } catch (e) {
      if (token !== popToken || !pop) return;
      body.textContent = '查詢失敗，請過幾秒再點一次。（' + e.message + '）';
    }
  }

  document.addEventListener('mousedown', e => {
    if (!pop || pop.contains(e.target)) return;            // 在小視窗裡面點（喇叭、連結）不要關掉
    if (e.target.closest && e.target.closest('.dt-w')) return;
    closePop();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && pop) closePop(); }, true);
  window.addEventListener('scroll', () => { if (pop && popWord) placePop(popWord); }, true);

  // 把一列英文拆成「字」：每個字有自己的時間（卡拉 OK 標記用），字母部分可點擊查字典
  function rowTokens(r) {
    if (r.ws && r.ws.length) return r.ws.map((x, k) => ({ t: k ? x.t : Math.min(x.t, r.start), w: x.w }));
    const parts = r.en.split(/\s+/).filter(Boolean);
    const total = parts.reduce((a, w) => a + w.length + 1, 0) || 1;
    const dur = Math.max(500, (r.end || r.start + 3000) - r.start);
    let acc = 0;
    return parts.map(w => { const t = r.start + Math.round(dur * acc / total); acc += w.length + 1; return { t, w }; });
  }

  function wordify(r, it) {
    const d = el('div', 'dt-en');
    const toks = [];
    rowTokens(r).forEach((tk, k) => {
      if (k) d.append(document.createTextNode(' '));
      const span = el('span', 'dt-tok');
      tk.w.split(/([A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z])/).forEach((part, i) => {
        if (!part) return;
        if (i % 2 === 1) span.append(el('span', 'dt-w', part));
        else span.append(document.createTextNode(part));
      });
      d.append(span);
      toks.push({ t: tk.t, el: span });
    });
    it._toks = toks;
    return d;
  }

  /* ---------- 影片內雙語字幕 ---------- */
  let box, lineO, lineT, lastO = null, lastT = null;
  function ensureOverlay(player) {
    if (box && box.parentNode === player) return;
    box = el('div'); box.id = 'dualsubs-box';
    lineO = el('div'); lineO.style.color = CONFIG.origColor;
    lineT = el('div'); lineT.style.color = CONFIG.transColor;
    box.append(lineO, lineT);
    player.appendChild(box);
    lastO = lastT = null;
  }

  function ensureModeButton(player) {
    const right = player.querySelector('.ytp-right-controls');
    if (!right || right.querySelector('#dualsubs-btn')) return;
    const b = el('button', 'ytp-button', MODE_LABEL[settings.mode]);
    b.id = 'dualsubs-btn';
    b.title = '影片內字幕：雙語 / 原文 / 中文 / 關閉（逐字稿在右邊）';
    b.addEventListener('click', e => {
      e.stopPropagation();
      settings.mode = MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length];
      save('mode');
      b.textContent = MODE_LABEL[settings.mode];
      lastO = lastT = null;
    });
    right.insertBefore(b, right.firstChild);
  }

  /* ---------- 自動開字幕（讓播放器去抓字幕） ---------- */
  const autoTried = new Set();
  let navTime = Date.now();
  window.addEventListener('yt-navigate-finish', () => { navTime = Date.now(); });

  function maybeAutoCaptions(player, video, cur) {
    if (settings.collapsed && settings.mode === 'off') return;   // 收合時不自動開字幕
    if (location.pathname !== '/watch' || !cur || state.videoId === cur || autoTried.has(cur)) return;
    if (Date.now() - navTime < 3000 || !video || video.paused || player.classList.contains('ad-showing')) return;
    const cc = player.querySelector('.ytp-subtitles-button');
    if (!cc || cc.offsetParent === null) return;           // 沒有字幕按鈕 = 這支影片沒字幕
    autoTried.add(cur);
    if (cc.getAttribute('aria-pressed') === 'true') {      // 字幕已開但沒攔到 → 關掉再打開
      cc.click();
      setTimeout(() => cc.click(), 400);
    } else {
      cc.click();
    }
  }

  /* ---------- 主迴圈 ---------- */
  let frame = 0;
  function tick() {
    requestAnimationFrame(tick);
    const player = getPlayer();
    if (!player) return;
    const video = player.querySelector('video');
    const cur = currentVideoId(player);
    const slow = ++frame % 30 === 0;

    if (slow) {
      ensureModeButton(player);
      maybeAutoCaptions(player, video, cur);
      if (ensurePanel(player)) {
        const key = cur === state.videoId ? cur + ':' + state.version : 'none:' + cur;
        if (key !== renderedKey) { renderedKey = key; renderList(cur); }
        followCheck();
        if (activeIdx >= 0) ensureTranslated(activeIdx);
        // 聽寫：換影片就停；沒有字幕時顯示「聽寫」選項
        if (dict.on && dict.videoId !== cur) stopDictation();
        if (video && !video.__dictHooked) {
          video.__dictHooked = true;
          video.addEventListener('play', () => { if (dict.on && !dict.rec) runRec(); });
          video.addEventListener('pause', () => { if (dict.rec) { try { dict.rec.stop(); } catch (e) {} } });
        }
        const offer = location.pathname === '/watch' && cur && !player.classList.contains('ad-showing') &&
          ((dict.on && dict.videoId === cur) || (dict.videoId === cur && String(state.key).startsWith('dict:')) ||
           (state.videoId !== cur && Date.now() - navTime > 6000 && noCaptionTracks(player)));
        refreshDictBarLazy(!!offer);
      }
    }

    const ad = player.classList.contains('ad-showing');
    const t = video ? video.currentTime * 1000 : 0;

    // 面板高亮
    if (items.length && video && !ad && cur === state.videoId) {
      const idx = lastStartIdx(state.rows, t);
      if (idx !== activeIdx) {
        if (items[activeIdx]) items[activeIdx].classList.remove('active');
        activeIdx = idx;
        if (items[idx]) { items[idx].classList.add('active'); scrollToActive(false); }
      }
      // 目前句子：已唸過的字變紫色，正在唸的字淡紫底（VoiceTube 風格）
      const rowEl = items[idx] || null;
      const toks = rowEl && rowEl._toks;
      let k = -1;
      if (toks) for (let j = 0; j < toks.length && toks[j].t <= t; j++) k = j;
      if (rowEl !== speakRow || k !== speakK) {
        if (speakRow && speakRow !== rowEl && speakRow._toks) speakRow._toks.forEach(x => x.el.classList.remove('said', 'speak'));
        if (toks) toks.forEach((x, j) => { x.el.classList.toggle('said', j < k); x.el.classList.toggle('speak', j === k); });
        speakRow = rowEl; speakK = k;
      }
    }

    // 影片內字幕
    const cc = player.querySelector('.ytp-subtitles-button');
    const ccOn = cc && cc.getAttribute('aria-pressed') === 'true';
    const active = !!(video && ccOn && !ad && state.videoId === cur && state.rows.length);
    // 收合且影片內字幕關閉時，不干擾 YouTube 原本的字幕
    document.documentElement.classList.toggle('dualsubs-on', active && !(settings.collapsed && settings.mode === 'off'));   // 隱藏 YouTube 原本的字幕
    if (!active || settings.mode === 'off') { if (box) box.style.display = 'none'; return; }

    ensureOverlay(player);
    box.style.display = 'block';
    const fs = Math.max(14, player.clientHeight * 0.042 * CONFIG.fontScale);
    lineO.style.fontSize = fs + 'px';
    lineT.style.fontSize = fs + 'px';

    const o = findCue(state.orig, t);
    const tr = findCue(state.trans, t);
    let oText = o ? o.text : '';
    let tText = tr ? tr.text : '';
    if (oText === tText) tText = '';
    if (settings.mode === 'orig') tText = '';
    if (settings.mode === 'trans' && state.trans.length) oText = '';
    if (oText !== lastO) { lineO.textContent = oText; lastO = oText; }
    if (tText !== lastT) { lineT.textContent = tText; lastT = tText; }
  }

  addStyle();
  requestAnimationFrame(tick);
})();
