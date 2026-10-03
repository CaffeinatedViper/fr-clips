import { cards as cardStore, kv } from './db.js';
import { newSrs, grade, preview, GRADES } from './srs.js';
import { analyzeVideo, testKey, DEFAULT_MODEL } from './gemini.js';
import { findVideoId, thumbUrl, embedUrl, appUrlAt, formatTime, videoInfo } from './youtube.js';

const DEFAULT_SETTINGS = { apiKey: '', model: DEFAULT_MODEL, maxAdd: 8, candidates: 15, maxReviews: 60 };
const LEARNING_WINDOW = 20 * 60 * 1000; // karty z krótkim interwałem wracają w tej samej sesji
const SECONDS_PER_CARD = 10;

const state = {
  settings: { ...DEFAULT_SETTINGS },
  cards: [],
  days: {},
  pending: null,   // gotowe zwroty z ostatniego filmiku, czekają na wybór
  inflight: null,  // { videoId, startedAt } — analiza w toku
  sharedVideoId: null, // link udostępniony przed ustawieniem klucza
  screen: 'home',
  review: null,
  video: null,
  deckQuery: '',
};

const app = document.getElementById('app');

// ---------- pomocnicze ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dayKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function today() {
  const k = dayKey();
  state.days[k] ??= { r: 0, v: 0 };
  return state.days[k];
}

const saveDays = () => kv.set('days', state.days);
const saveSettings = () => kv.set('settings', state.settings);

const normalize = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();

function highlight(sentence, match) {
  const text = esc(sentence);
  if (!match) return text;
  const m = esc(match);
  const i = text.toLowerCase().indexOf(m.toLowerCase());
  if (i < 0) return text;
  return `${text.slice(0, i)}<mark>${text.slice(i, i + m.length)}</mark>${text.slice(i + m.length)}`;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2200);
  setTimeout(() => el.remove(), 2700);
}

let frVoice = null;
function loadVoice() {
  const voices = speechSynthesis?.getVoices?.() || [];
  frVoice = voices.find(v => v.lang === 'fr-FR' && /google/i.test(v.name)) || voices.find(v => v.lang?.startsWith('fr')) || null;
}
if ('speechSynthesis' in window) {
  loadVoice();
  speechSynthesis.onvoiceschanged = loadVoice;
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  if (frVoice) u.voice = frVoice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

function openClip(videoId, t, embed = true) {
  closeClip();
  // Film z zablokowanym osadzaniem: od razu do aplikacji YouTube, w odpowiednim momencie.
  if (embed === false) {
    window.open(appUrlAt(videoId, t), '_blank', 'noopener');
    return;
  }
  const el = document.createElement('div');
  el.className = 'clip';
  el.innerHTML = `
    <div class="clip-box">
      <iframe src="${embedUrl(videoId, t)}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; encrypted-media" allowfullscreen title="Fragment filmu"></iframe>
      <div class="clip-actions">
        <a class="btn ghost" href="${appUrlAt(videoId, t)}" target="_blank" rel="noopener">Otwórz w YouTube</a>
        <button class="btn" data-close>Zamknij</button>
      </div>
    </div>`;
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) closeClip(); });
  document.body.appendChild(el);
}
const closeClip = () => document.querySelector('.clip')?.remove();

function dueCards(now = Date.now()) {
  return state.cards.filter(c => c.srs.due <= now).sort((a, b) => a.srs.due - b.srs.due);
}

function reviewsLeftToday() {
  return Math.max(0, state.settings.maxReviews - today().r);
}

// ---------- nawigacja (z obsługą przycisku „wstecz” na Androidzie) ----------

function go(screen, { replace = false } = {}) {
  closeClip();
  state.screen = screen;
  if (screen === 'home') history.replaceState({ screen }, '');
  else if (replace) history.replaceState({ screen }, '');
  else history.pushState({ screen }, '');
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', e => {
  closeClip();
  state.screen = e.state?.screen || 'home';
  if (state.screen === 'review' && !state.review) state.screen = 'home';
  render();
});

function render() {
  const screens = { home: renderHome, review: renderReview, video: renderVideo, deck: renderDeck, settings: renderSettings };
  (screens[state.screen] || renderHome)();
}

// ---------- ekran główny ----------

function weekHtml() {
  const names = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So'];
  let count = 0;
  const dots = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const info = state.days[dayKey(d)];
    const done = info && (info.r > 0 || info.v > 0);
    if (done) count++;
    dots.push(`<div class="day ${done ? 'done' : ''} ${i === 0 ? 'today' : ''}"><span></span><small>${names[d.getDay()]}</small></div>`);
  }
  const msg = count === 0 ? 'Zacznij tydzień 🙂' : count >= 5 ? `${count}/7 dni — super rytm 🔥` : `${count}/7 dni w tym tygodniu`;
  return `<section class="week"><div class="days">${dots.join('')}</div><p>${msg}</p></section>`;
}

function renderHome() {
  const s = state.settings;
  if (!s.apiKey) return renderOnboarding();

  const due = dueCards();
  const left = reviewsLeftToday();
  const n = Math.min(due.length, left);
  const newCount = due.slice(0, n).filter(c => c.srs.reps === 0).length;
  const t = today();

  let reviewBlock;
  if (state.cards.length === 0) {
    reviewBlock = `<section class="panel"><h2>Twoja talia jest pusta</h2><p class="muted">Dodaj pierwszy filmik poniżej, a zwroty z niego trafią tutaj.</p></section>`;
  } else if (n > 0) {
    const mins = Math.max(1, Math.round((n * SECONDS_PER_CARD) / 60));
    reviewBlock = `
      <section class="panel primary">
        <p class="eyebrow">Krok 1 · Powtórka</p>
        <h2>${n} ${plural(n, 'karta', 'karty', 'kart')}</h2>
        <p class="muted">ok. ${mins} min${newCount ? ` · w tym ${newCount} ${plural(newCount, 'nowa', 'nowe', 'nowych')}` : ''}</p>
        <button class="btn big" data-action="start-review">Zaczynam</button>
      </section>`;
  } else {
    const msg = due.length > 0 ? 'Na dziś wystarczy — reszta jutro.' : t.r > 0 ? `Zrobione: ${t.r} ${plural(t.r, 'karta', 'karty', 'kart')} dziś.` : 'Nic do powtórki — wszystko pamiętasz.';
    reviewBlock = `<section class="panel done-panel"><p class="eyebrow">Krok 1 · Powtórka</p><h2>✓ Gotowe</h2><p class="muted">${msg}</p></section>`;
  }

  app.innerHTML = `
    <header class="top"><h1>FR Clips</h1><button class="icon" data-action="settings" aria-label="Ustawienia">⚙︎</button></header>
    ${weekHtml()}
    ${reviewBlock}
    ${videoBlockHtml()}
    <nav class="bottom">
      <button class="btn ghost" data-action="deck">Talia (${state.cards.length})</button>
    </nav>`;
  bindHome();
}

function videoBlockHtml() {
  if (state.inflight) {
    return `
      <section class="panel">
        <p class="eyebrow">Krok 2 · Filmik</p>
        <div class="row"><div class="spinner"></div><div><h3>Analizuję filmik…</h3><p class="muted">Możesz w tym czasie oglądać — wynik się zapisze.</p></div></div>
        <button class="btn ghost" data-action="video">Pokaż</button>
      </section>`;
  }
  if (state.pending) {
    const p = state.pending;
    return `
      <section class="panel primary">
        <p class="eyebrow">Krok 2 · Filmik</p>
        <div class="video-head"><img src="${thumbUrl(p.videoId)}" alt=""><div><h3>${esc(p.title)}</h3><p class="muted">${p.items.length} zwrotów czeka na Ciebie</p></div></div>
        <button class="btn big" data-action="video">Wybierz zwroty</button>
      </section>`;
  }
  return `
    <section class="panel">
      <p class="eyebrow">Krok 2 · Filmik</p>
      <h2>Co dziś oglądasz?</h2>
      <form class="link-form" data-form="link">
        <input name="url" type="url" inputmode="url" placeholder="Wklej link z YouTube" autocomplete="off">
        <button type="button" class="btn ghost small" data-action="paste">Wklej</button>
      </form>
      <button class="btn big" data-action="analyze">Wyciągnij zwroty</button>
      <p class="hint">Szybciej: w YouTube kliknij <b>Udostępnij → FR Clips</b>.</p>
    </section>`;
}

function bindHome() {
  app.querySelector('[data-action="start-review"]')?.addEventListener('click', startReview);
  app.querySelector('[data-action="settings"]')?.addEventListener('click', () => go('settings'));
  app.querySelector('[data-action="deck"]')?.addEventListener('click', () => go('deck'));
  app.querySelector('[data-action="video"]')?.addEventListener('click', () => {
    state.video = state.pending ? { phase: 'results', selected: new Set() } : { phase: 'loading' };
    go('video');
  });
  const input = app.querySelector('input[name="url"]');
  app.querySelector('[data-action="paste"]')?.addEventListener('click', async () => {
    try {
      input.value = await navigator.clipboard.readText();
    } catch {
      input.focus();
      toast('Przytrzymaj pole i wybierz „Wklej”');
    }
  });
  const submit = () => {
    const id = findVideoId(input.value);
    if (!id) return toast('To nie wygląda na link z YouTube');
    startAnalysis(id);
  };
  app.querySelector('[data-action="analyze"]')?.addEventListener('click', submit);
  app.querySelector('[data-form="link"]')?.addEventListener('submit', e => { e.preventDefault(); submit(); });
}

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

// ---------- pierwsze uruchomienie ----------

function renderOnboarding() {
  app.innerHTML = `
    <header class="top"><h1>FR Clips</h1></header>
    <section class="panel">
      <h2>Bonjour! Jeden krok na start</h2>
      <p>Apka używa darmowego <b>Gemini</b> od Google, żeby „obejrzeć” filmik i wybrać z niego zwroty. Potrzebny jest Twój własny klucz — zostaje tylko na tym telefonie.</p>
      <ol class="steps">
        <li>Otwórz <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> i zaloguj się kontem Google.</li>
        <li>Kliknij <b>Create API key</b> i skopiuj klucz.</li>
        <li>Wklej go poniżej.</li>
      </ol>
      <form data-form="key">
        <input name="key" type="password" placeholder="Klucz Gemini" autocomplete="off">
        <button class="btn big" type="submit">Zapisz i zaczynamy</button>
      </form>
    </section>`;
  app.querySelector('[data-form="key"]').addEventListener('submit', async e => {
    e.preventDefault();
    const key = e.target.key.value.trim();
    if (!key) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Sprawdzam…';
    try {
      await testKey(key);
      state.settings.apiKey = key;
      await saveSettings();
      toast('Klucz działa ✓');
      if (state.sharedVideoId) {
        const id = state.sharedVideoId;
        state.sharedVideoId = null;
        startAnalysis(id);
      } else render();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Zapisz i zaczynamy';
      toast(`Klucz nie działa: ${err.message}`);
    }
  });
}

// ---------- powtórka ----------

function startReview() {
  const due = dueCards().slice(0, reviewsLeftToday());
  if (!due.length) return;
  state.review = { queue: due.map(c => c.id), done: 0, total: due.length, back: false };
  go('review');
}

function renderReview() {
  const r = state.review;
  if (!r) return go('home', { replace: true });
  const card = state.cards.find(c => c.id === r.queue[0]);

  if (!card) {
    const t = today();
    app.innerHTML = `
      <header class="top"><button class="icon" data-action="home" aria-label="Wróć">←</button><h1>Powtórka</h1><span></span></header>
      <section class="panel finish">
        <div class="big-emoji">🎉</div>
        <h2>Powtórka zrobiona!</h2>
        <p class="muted">${t.r} ${plural(t.r, 'karta', 'karty', 'kart')} dziś. Teraz czas na filmik.</p>
        <button class="btn big" data-action="home">Dalej</button>
      </section>`;
    app.querySelectorAll('[data-action="home"]').forEach(b => b.addEventListener('click', () => { state.review = null; go('home'); }));
    return;
  }

  const progress = Math.round((r.done / Math.max(r.total, r.done + r.queue.length)) * 100);
  const intervals = r.back ? preview(card.srs) : null;

  app.innerHTML = `
    <header class="top">
      <button class="icon" data-action="home" aria-label="Wróć">←</button>
      <div class="progress"><span style="width:${progress}%"></span></div>
      <span class="count">${r.queue.length}</span>
    </header>
    <article class="flash ${r.back ? 'flipped' : ''}" data-action="flip">
      <div class="front">
        <p class="phrase">${esc(card.fr)}</p>
        ${card.sfr ? `<p class="sentence">${highlight(card.sfr, card.match)}</p>` : ''}
        <div class="tools">
          <button class="chip" data-action="speak">🔊 Posłuchaj</button>
          ${card.vid ? `<button class="chip" data-action="clip">▶ Fragment ${formatTime(card.t)}</button>` : ''}
        </div>
      </div>
      ${r.back ? `
        <div class="back">
          <p class="meaning">${esc(card.pl)}</p>
          ${card.spl ? `<p class="sentence-pl">${esc(card.spl)}</p>` : ''}
          ${card.note ? `<p class="note">💡 ${esc(card.note)}</p>` : ''}
        </div>` : `<p class="tap-hint">Dotknij, żeby zobaczyć znaczenie</p>`}
    </article>
    <div class="answer">
      ${r.back
        ? GRADES.map(g => `<button class="grade ${g.cls}" data-grade="${g.rating}"><span>${g.label}</span><small>${intervals[g.rating]}</small></button>`).join('')
        : `<button class="btn big" data-action="show">Pokaż</button>`}
    </div>
    <button class="link danger" data-action="delete">Usuń tę kartę</button>`;

  app.querySelector('[data-action="home"]').addEventListener('click', () => { state.review = null; go('home'); });
  app.querySelector('[data-action="speak"]').addEventListener('click', e => { e.stopPropagation(); speak(r.back ? card.sfr || card.fr : card.fr); });
  app.querySelector('[data-action="clip"]')?.addEventListener('click', e => { e.stopPropagation(); openClip(card.vid, card.t, card.embed); });
  const flip = () => { if (!r.back) { r.back = true; render(); } };
  app.querySelector('[data-action="flip"]').addEventListener('click', flip);
  app.querySelector('[data-action="show"]')?.addEventListener('click', flip);
  app.querySelectorAll('[data-grade]').forEach(b => b.addEventListener('click', () => answer(card, +b.dataset.grade)));

  const del = app.querySelector('[data-action="delete"]');
  del.addEventListener('click', async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = '1';
      del.textContent = 'Na pewno? Dotknij jeszcze raz';
      return;
    }
    await removeCard(card.id);
    r.queue.shift();
    r.back = false;
    render();
  });
}

async function answer(card, rating) {
  const r = state.review;
  const now = new Date();
  card.srs = grade(card.srs, rating, now);
  await cardStore.put(card);
  r.queue.shift();
  r.back = false;
  r.done++;
  if (card.srs.due - +now < LEARNING_WINDOW) r.queue.push(card.id);
  today().r++;
  await saveDays();
  render();
}

async function removeCard(id) {
  await cardStore.remove(id);
  state.cards = state.cards.filter(c => c.id !== id);
  toast('Karta usunięta');
}

// ---------- filmik ----------

async function startAnalysis(videoId) {
  if (!state.settings.apiKey) {
    state.sharedVideoId = videoId;
    return go('home', { replace: true });
  }
  if (state.inflight) return toast('Poczekaj, analizuję poprzedni filmik');
  state.inflight = { videoId, startedAt: Date.now() };
  await kv.set('inflight', state.inflight);
  state.video = { phase: 'loading' };
  go('video');

  try {
    const known = state.cards.slice(-400).map(c => c.fr);
    const infoPromise = videoInfo(videoId);
    const result = await analyzeVideo({
      videoId,
      key: state.settings.apiKey,
      model: state.settings.model,
      count: state.settings.candidates,
      known,
    });
    if (!result.is_french) throw new Error('Ten filmik nie wygląda na francuski. Wybierz filmik po francusku.');
    const knownSet = new Set(state.cards.map(c => normalize(c.fr)));
    const items = result.items.filter(i => !knownSet.has(normalize(i.fr)));
    if (!items.length) throw new Error('Nie znalazłem nowych zwrotów w tym filmiku. Spróbuj innego.');
    const info = await infoPromise;
    state.pending = { videoId, title: info.title || result.title || 'Filmik', embed: info.embed, items, createdAt: Date.now() };
    await kv.set('pending', state.pending);
    state.video = { phase: 'results', selected: new Set() };
    if (state.screen !== 'video') toast('Zwroty z filmiku są gotowe ✓');
  } catch (err) {
    state.video = { phase: 'error', error: err.message, code: err.code, videoId };
  } finally {
    state.inflight = null;
    await kv.remove('inflight');
    if (state.screen === 'video' || state.screen === 'home') render();
  }
}

let loadingTimer;
function renderVideo() {
  clearInterval(loadingTimer);
  const v = state.video || { phase: state.pending ? 'results' : 'loading', selected: new Set() };
  state.video = v;
  const header = `<header class="top"><button class="icon" data-action="home" aria-label="Wróć">←</button><h1>Filmik</h1><span></span></header>`;

  if (v.phase === 'loading' && state.inflight) {
    const tips = [
      'Gemini słucha filmiku…',
      'Szukam zwrotów, które naprawdę się przydają…',
      'Tłumaczę je w kontekście…',
      'Jeszcze chwilka — dłuższe filmiki trwają dłużej.',
      'Gemini jest teraz zatłoczony — ponawiam sam. Możesz oglądać, wynik się zapisze.',
    ];
    const tipAt = sec => tips[sec < 15 ? 0 : sec < 35 ? 1 : sec < 60 ? 2 : sec < 100 ? 3 : 4];
    app.innerHTML = `${header}
      <section class="panel loading">
        <div class="spinner big"></div>
        <h2 data-tip>${tips[0]}</h2>
        <p class="muted"><span data-sec>0</span> s · zwykle 30–90 s</p>
        <p class="hint">Możesz wyjść i oglądać filmik — gdy wrócisz, zwroty będą czekać.</p>
      </section>`;
    const started = state.inflight.startedAt;
    loadingTimer = setInterval(() => {
      if (state.screen !== 'video' || !state.inflight) return clearInterval(loadingTimer);
      const sec = Math.round((Date.now() - started) / 1000);
      const secEl = app.querySelector('[data-sec]');
      const tipEl = app.querySelector('[data-tip]');
      if (secEl) secEl.textContent = sec;
      if (tipEl) tipEl.textContent = tipAt(sec);
    }, 1000);
  } else if (v.phase === 'error') {
    app.innerHTML = `${header}
      <section class="panel">
        <h2>Nie wyszło 😕</h2>
        <p>${esc(v.error)}</p>
        ${v.code === 'key' ? `<button class="btn big" data-action="settings">Otwórz ustawienia</button>`
          : v.videoId ? `<button class="btn big" data-action="retry">Spróbuj jeszcze raz</button>` : ''}
        <button class="btn ghost big" data-action="home">Wróć</button>
      </section>`;
    app.querySelector('[data-action="retry"]')?.addEventListener('click', () => startAnalysis(v.videoId));
    app.querySelector('[data-action="settings"]')?.addEventListener('click', () => go('settings', { replace: true }));
  } else if (state.pending) {
    renderResults(header);
    return;
  } else {
    return go('home', { replace: true });
  }
  app.querySelectorAll('[data-action="home"]').forEach(b => b.addEventListener('click', () => go('home')));
}

function renderResults(header) {
  const p = state.pending;
  const v = state.video;
  v.selected ??= new Set();
  const max = state.settings.maxAdd;
  const full = v.selected.size >= max;

  app.innerHTML = `${header}
    <div class="video-head page"><img src="${thumbUrl(p.videoId)}" alt=""><div><h3>${esc(p.title)}</h3><p class="muted">Wybierz do ${max} zwrotów, których chcesz się nauczyć.</p></div></div>
    <ul class="items">
      ${p.items.map((it, i) => {
        const on = v.selected.has(i);
        return `
        <li class="item ${on ? 'on' : ''}">
          <div class="item-main" data-toggle="${i}">
            <p class="phrase">${esc(it.fr)} ${it.level ? `<span class="lvl">${esc(it.level)}</span>` : ''}</p>
            <p class="meaning">${esc(it.pl)}</p>
            ${it.sentence_fr ? `<p class="sentence">${highlight(it.sentence_fr, it.match)}</p>` : ''}
            ${it.sentence_pl ? `<p class="sentence-pl">${esc(it.sentence_pl)}</p>` : ''}
            ${it.note ? `<p class="note">💡 ${esc(it.note)}</p>` : ''}
          </div>
          <div class="item-side">
            <button class="add ${on ? 'on' : ''}" data-toggle="${i}" ${!on && full ? 'disabled' : ''} aria-label="${on ? 'Usuń z wyboru' : 'Dodaj'}">${on ? '✓' : '+'}</button>
            <button class="chip small" data-clip="${i}">▶ ${formatTime(it.t)}</button>
          </div>
        </li>`;
      }).join('')}
    </ul>
    <div class="sticky">
      <button class="btn big" data-action="add" ${v.selected.size ? '' : 'disabled'}>${v.selected.size ? `Dodaj ${v.selected.size} do talii` : 'Zaznacz zwroty (+)'}</button>
      <button class="link" data-action="discard">Odrzuć ten filmik</button>
    </div>`;

  app.querySelector('[data-action="home"]').addEventListener('click', () => go('home'));
  app.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('click', e => {
    if (e.target.closest('[data-clip]')) return;
    const i = +el.dataset.toggle;
    if (v.selected.has(i)) v.selected.delete(i);
    else if (v.selected.size < max) v.selected.add(i);
    else return toast(`Maks. ${max} — mniej kart = lżejsze powtórki`);
    const y = window.scrollY;
    renderResults(header);
    window.scrollTo(0, y);
  }));
  app.querySelectorAll('[data-clip]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    openClip(p.videoId, p.items[+b.dataset.clip].t, p.embed);
  }));
  app.querySelector('[data-action="add"]').addEventListener('click', addSelected);
  const discard = app.querySelector('[data-action="discard"]');
  discard.addEventListener('click', async () => {
    if (!discard.dataset.armed) {
      discard.dataset.armed = '1';
      discard.textContent = 'Na pewno odrzucić? Dotknij jeszcze raz';
      return;
    }
    state.pending = null;
    await kv.remove('pending');
    go('home');
  });
}

async function addSelected() {
  const p = state.pending;
  const v = state.video;
  const now = Date.now();
  const added = [...v.selected].sort((a, b) => a - b).map((i, n) => {
    const it = p.items[i];
    return {
      id: `${now.toString(36)}-${n}-${Math.random().toString(36).slice(2, 7)}`,
      fr: it.fr, pl: it.pl, sfr: it.sentence_fr, spl: it.sentence_pl, match: it.match,
      note: it.note, level: it.level, vid: p.videoId, t: it.t, title: p.title, embed: p.embed,
      created: now,
      srs: newSrs(new Date(now)),
    };
  });
  await cardStore.putMany(added);
  state.cards.push(...added);
  today().v++;
  await saveDays();
  state.pending = null;
  state.video = null;
  await kv.remove('pending');
  toast(`Dodano ${added.length} ${plural(added.length, 'kartę', 'karty', 'kart')} ✓`);
  go('home');
}

// ---------- talia ----------

function renderDeck() {
  const q = normalize(state.deckQuery);
  const list = state.cards
    .filter(c => !q || normalize(`${c.fr} ${c.pl}`).includes(q))
    .sort((a, b) => b.created - a.created);
  const now = Date.now();

  app.innerHTML = `
    <header class="top"><button class="icon" data-action="home" aria-label="Wróć">←</button><h1>Talia (${state.cards.length})</h1><span></span></header>
    <input class="search" type="search" placeholder="Szukaj…" value="${esc(state.deckQuery)}">
    <ul class="deck">
      ${list.map(c => `
        <li>
          <details>
            <summary><b>${esc(c.fr)}</b><span class="muted"> — ${esc(c.pl)}</span></summary>
            <div class="deck-more">
              ${c.sfr ? `<p class="sentence">${highlight(c.sfr, c.match)}</p>` : ''}
              <p class="muted small">${c.srs.due <= now ? 'Do powtórki teraz' : `Następna powtórka za ${relative(c.srs.due - now)}`} · z: ${esc(c.title || '—')}</p>
              <div class="tools">
                ${c.vid ? `<button class="chip small" data-clip="${esc(c.id)}">▶ Fragment</button>` : ''}
                <button class="chip small danger" data-del="${esc(c.id)}">Usuń</button>
              </div>
            </div>
          </details>
        </li>`).join('') || `<li class="muted empty">${state.cards.length ? 'Nic nie znaleziono.' : 'Talia jest pusta.'}</li>`}
    </ul>`;

  app.querySelector('[data-action="home"]').addEventListener('click', () => go('home'));
  const search = app.querySelector('.search');
  search.addEventListener('input', () => {
    state.deckQuery = search.value;
    renderDeck();
    const s = app.querySelector('.search');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  });
  app.querySelectorAll('[data-clip]').forEach(b => b.addEventListener('click', () => {
    const c = state.cards.find(x => x.id === b.dataset.clip);
    openClip(c.vid, c.t, c.embed);
  }));
  app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!b.dataset.armed) {
      b.dataset.armed = '1';
      b.textContent = 'Na pewno?';
      return;
    }
    await removeCard(b.dataset.del);
    renderDeck();
  }));
}

function relative(ms) {
  const d = Math.round(ms / 86400000);
  if (d < 1) return `${Math.max(1, Math.round(ms / 3600000))} h`;
  return d === 1 ? '1 dzień' : `${d} dni`;
}

// ---------- ustawienia ----------

function renderSettings() {
  const s = state.settings;
  app.innerHTML = `
    <header class="top"><button class="icon" data-action="home" aria-label="Wróć">←</button><h1>Ustawienia</h1><span></span></header>
    <form class="panel settings" data-form="settings">
      <label>Klucz Gemini
        <input name="apiKey" type="password" value="${esc(s.apiKey)}" autocomplete="off">
        <small><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></small>
      </label>
      <label>Maks. zwrotów do dodania z jednego filmiku
        <input name="maxAdd" type="number" min="1" max="20" value="${s.maxAdd}">
        <small>Mniej kart = lżejsze powtórki. Polecam 5–8.</small>
      </label>
      <label>Ile zwrotów ma zaproponować Gemini
        <input name="candidates" type="number" min="5" max="30" value="${s.candidates}">
      </label>
      <label>Limit powtórek dziennie
        <input name="maxReviews" type="number" min="10" max="500" value="${s.maxReviews}">
        <small>Chroni przed „lawiną” po kilku dniach przerwy.</small>
      </label>
      <label>Model Gemini
        <input name="model" type="text" value="${esc(s.model)}" autocomplete="off">
        <small>Domyślnie ${DEFAULT_MODEL}.</small>
      </label>
      <button class="btn big" type="submit">Zapisz</button>
    </form>
    <section class="panel">
      <h2>Kopia zapasowa</h2>
      <p class="muted">Talia jest tylko na tym telefonie. Raz na jakiś czas zrób kopię.</p>
      <div class="row-buttons">
        <button class="btn ghost" data-action="export">Zapisz kopię</button>
        <label class="btn ghost file">Wczytaj kopię<input type="file" accept="application/json,.json" hidden></label>
      </div>
      <p class="muted small" data-storage></p>
    </section>`;

  app.querySelector('[data-action="home"]').addEventListener('click', () => go('home'));
  app.querySelector('[data-form="settings"]').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const int = (v, lo, hi, def) => Math.min(hi, Math.max(lo, parseInt(v, 10) || def));
    state.settings = {
      ...s,
      apiKey: f.apiKey.value.trim(),
      model: f.model.value.trim() || DEFAULT_MODEL,
      maxAdd: int(f.maxAdd.value, 1, 20, 8),
      candidates: int(f.candidates.value, 5, 30, 15),
      maxReviews: int(f.maxReviews.value, 10, 500, 60),
    };
    await saveSettings();
    toast('Zapisano ✓');
    go('home');
  });
  app.querySelector('[data-action="export"]').addEventListener('click', exportBackup);
  app.querySelector('input[type="file"]').addEventListener('change', e => importBackup(e.target.files[0]));

  navigator.storage?.persisted?.().then(p => {
    const el = app.querySelector('[data-storage]');
    if (el) el.textContent = p ? 'Pamięć trwała: włączona ✓ (przeglądarka nie usunie talii sama).' : 'Pamięć trwała: niepotwierdzona — zainstaluj apkę na ekranie głównym.';
  });
}

function exportBackup() {
  const { apiKey, ...settings } = state.settings;
  const data = { app: 'fr-clips', version: 1, exportedAt: new Date().toISOString(), settings, days: state.days, cards: state.cards };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fr-clips-kopia-${dayKey()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  kv.set('lastBackup', Date.now());
}

async function importBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'fr-clips' || !Array.isArray(data.cards)) throw new Error();
    const byId = new Map(state.cards.map(c => [c.id, c]));
    data.cards.forEach(c => byId.set(c.id, c));
    state.cards = [...byId.values()];
    await cardStore.putMany(data.cards);
    state.days = { ...data.days, ...state.days };
    await saveDays();
    toast(`Wczytano ${data.cards.length} kart ✓`);
    go('home');
  } catch {
    toast('To nie jest poprawna kopia FR Clips');
  }
}

// ---------- start ----------

function sharedVideoFromUrl() {
  const params = new URLSearchParams(location.search);
  const text = ['url', 'text', 'title'].map(k => params.get(k) || '').join(' ');
  const id = findVideoId(text);
  if (params.toString()) history.replaceState({ screen: 'home' }, '', location.pathname);
  return id;
}

async function init() {
  const [settings, cards, days, pending, inflight] = await Promise.all([
    kv.get('settings'), cardStore.all(), kv.get('days'), kv.get('pending'), kv.get('inflight'),
  ]);
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  state.cards = cards || [];
  state.days = days || {};
  state.pending = pending || null;
  history.replaceState({ screen: 'home' }, '');

  const sharedId = sharedVideoFromUrl();
  if (inflight) {
    // Apka została zamknięta w trakcie analizy — zaproponuj ponowienie.
    await kv.remove('inflight');
    if (!sharedId) {
      state.video = { phase: 'error', error: 'Analiza została przerwana (apka była zamknięta).', videoId: inflight.videoId };
      state.screen = 'video';
      history.pushState({ screen: 'video' }, '');
    }
  }

  render();
  if (sharedId) startAnalysis(sharedId);

  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// Wracając do apki po kilku godzinach odśwież ekran główny (nowe karty do powtórki).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'home') render();
});

init();
