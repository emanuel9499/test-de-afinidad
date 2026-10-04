'use strict';

document.addEventListener('DOMContentLoaded', () => {

// ════════════════════════════════════════════════════════════════
// Configuración
// ════════════════════════════════════════════════════════════════
const GENRE_MAP = {
    'Romantic Comedy': 'Romance',
    'Psychological': 'Suspense',
    'Slice of Life': 'Slice of Life',
    'Sci-Fi': 'Sci-Fi',
    'Fantasy': 'Fantasia',
    'Action': 'Action',
    'CGDCT': 'CGCDT',                         // nombre del tema en MAL
    'Cute Girls Doing Cute Things': 'CGCDT'   // etiqueta de AniList
};
const normalizeGenre = g => GENRE_MAP[g] || g;

const TEAMS = {
    yuyo: { name: 'Team Yuyo', color: '#ff6fae', text: '#ffb3d4', likes: ['Romance', 'Comedy', 'Slice of Life', 'Ecchi', 'CGCDT', 'Mecha', 'Music', 'Action'] },
    ema:  { name: 'Team Ema',  color: '#6f9bff', text: '#b5ccff', likes: ['Mystery', 'Sports', 'Suspense', 'Drama', 'Sci-Fi', 'Horror', 'Mecha', 'Music', 'Action'] },
    eze:  { name: 'Team Eze',  color: '#4fdc9c', text: '#a6f0cd', likes: ['Isekai', 'Adventure', 'Action', 'Fantasia'] }
};
const NO_TEAM_COLOR = '#4a5268';
const ANIME_PAGE = 24;

// ════════════════════════════════════════════════════════════════
// Utilidades
// ════════════════════════════════════════════════════════════════
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const output = $('#output');

function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// Redondeo que siempre suma 100 (método del mayor resto)
function roundTo100(values) {
    const total = values.reduce((a, b) => a + b, 0);
    if (!total) return values.map(() => 0);
    const raw = values.map(v => v / total * 100);
    const floor = raw.map(Math.floor);
    let rest = 100 - floor.reduce((a, b) => a + b, 0);
    raw.map((v, i) => [v - floor[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest-- > 0) floor[i]++; });
    return floor;
}

// ════════════════════════════════════════════════════════════════
// Datos (backend)
// ════════════════════════════════════════════════════════════════
async function fetchList(platform, username) {
    let res;
    try {
        res = await fetch(`/api/${platform}/${encodeURIComponent(username)}`);
    } catch {
        throw { kind: 'network' };
    }
    if (res.status === 404) throw { kind: 'notfound' };
    if (res.status === 403) throw { kind: 'private' };
    if (res.status === 429) throw { kind: 'ratelimit' };
    if (!res.ok) throw { kind: 'server', status: res.status };
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.animes || data.data || data.list || []);
    return list
        .filter(a => a && Array.isArray(a.genres))
        .map(a => ({
            title: a.title || a.name || 'Sin título',
            image: a.image || a.cover || a.coverImage || '',
            genres: [...new Set(a.genres.map(g => normalizeGenre(typeof g === 'string' ? g : g?.name)).filter(Boolean))],
            score: Number(a.score ?? a.user_score ?? a.my_score) || 0,
            status: a.status || 'unknown',
            url: a.url || (platform === 'mal' && (a.mal_id || a.id) ? `https://myanimelist.net/anime/${a.mal_id || a.id}`
                 : platform === 'anilist' && a.id ? `https://anilist.co/anime/${a.id}` : null)
        }));
}

// ════════════════════════════════════════════════════════════════
// Cálculo
// ════════════════════════════════════════════════════════════════
// Peso de cada anime: 1, o según tu puntaje si se pondera (10 → x2, 5 → x1, sin puntaje → x1)
const weightOf = (a, weighted) => weighted && a.score > 0 ? a.score / 5 : 1;

function calculateAffinity(animes, weighted) {
    const res = {};
    Object.keys(TEAMS).forEach(k => { res[k] = { raw: 0, genres: {}, animes: {} }; });

    animes.forEach(anime => {
        const w = weightOf(anime, weighted);
        anime.genres.forEach(genre => {
            Object.entries(TEAMS).forEach(([key, team]) => {
                if (!team.likes.includes(genre)) return;
                const r = res[key];
                r.raw += w;
                r.genres[genre] = (r.genres[genre] || 0) + 1;
                (r.animes[genre] ||= []).push(anime);
            });
        });
    });

    const keys = Object.keys(TEAMS);
    const pcts = roundTo100(keys.map(k => res[k].raw));
    keys.forEach((k, i) => { res[k].percent = pcts[i]; });
    return res;
}

function genreTotals(animes) {
    const totals = {};
    animes.forEach(a => a.genres.forEach(g => { totals[g] = (totals[g] || 0) + 1; }));
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

// ════════════════════════════════════════════════════════════════
// Estado
// ════════════════════════════════════════════════════════════════
let current = null;   // { username, platform, all, animes, weighted, dropped, affinity }

// Planeados nunca cuentan; abandonados solo si el usuario lo elige
function applyFilters() {
    current.animes = current.all.filter(a => a.status !== 'planning' && (current.dropped || a.status !== 'dropped'));
    current.affinity = calculateAffinity(current.animes, current.weighted);
}

// ════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════
function renderSkeleton() {
    output.innerHTML = `<div class="skel">
        <div style="height:190px"></div>
        <div style="height:66px"></div><div style="height:66px"></div><div style="height:66px"></div>
    </div>`;
}

function renderError(err, username) {
    const msgs = {
        notfound: `No encontramos al usuario <b>${esc(username)}</b>. Revisá que esté bien escrito y que sea la plataforma correcta.`,
        private: `La lista de <b>${esc(username)}</b> es privada. Hacela pública para poder analizarla.`,
        ratelimit: 'Hiciste muchas consultas seguidas. Esperá un minuto y probá de nuevo.',
        network: 'No pudimos conectarnos con el servidor. Revisá tu conexión.',
        server: 'El servidor tuvo un problema al buscar la lista. Probá de nuevo en un rato.',
        empty: `La lista de <b>${esc(username)}</b> no tiene animes vistos o en curso para analizar.`
    };
    output.innerHTML = `<div class="msg">${msgs[err.kind] || msgs.server}</div>`;
}

function renderResult() {
    const { username, platform, animes, weighted, affinity } = current;
    const droppedCount = current.all.filter(a => a.status === 'dropped').length;
    const sorted = Object.entries(affinity).sort((a, b) => b[1].percent - a[1].percent || b[1].raw - a[1].raw);
    const [winKey, win] = sorted[0];
    const team = TEAMS[winKey];
    const tied = sorted.filter(([, d]) => d.percent === win.percent).length > 1;
    const hasScores = animes.some(a => a.score > 0);
    const matched = animes.filter(a => a.genres.some(g => Object.values(TEAMS).some(t => t.likes.includes(g)))).length;
    const topGenre = Object.entries(win.genres).sort((a, b) => b[1] - a[1])[0];

    output.innerHTML = `
<section class="result">
    <div class="winner" style="--tc:${team.color};--tc-text:${team.text}">
        <div class="winner-user">${esc(username)} · ${platform === 'mal' ? 'MyAnimeList' : 'AniList'}</div>
        <div class="kicker">Tu team es</div>
        <div class="name">${esc(team.name)}</div>
        <div class="pct">${win.percent}%</div>
        ${tied ? `<div class="tie">Empate con ${sorted.filter(([k, d]) => k !== winKey && d.percent === win.percent).map(([k]) => esc(TEAMS[k].name)).join(' y ')}</div>` : ''}
        ${topGenre ? `<div class="desc">Lo que más te acerca: <b>${esc(topGenre[0])}</b> (${topGenre[1]} anime${topGenre[1] === 1 ? '' : 's'})</div>` : ''}
    </div>

    <div class="stats">
        <div class="stat"><div class="k">Animes analizados</div><div class="v">${animes.length}</div></div>
        <div class="stat"><div class="k">Con géneros de algún team</div><div class="v">${matched}</div></div>
        <div class="stat"><div class="k">Géneros distintos</div><div class="v">${genreTotals(animes).length}</div></div>
    </div>

    <div class="actions">
        ${hasScores ? `<label class="opt"><input type="checkbox" id="weightChk" ${weighted ? 'checked' : ''}> Ponderar por mi puntaje</label>` : ''}
        ${droppedCount ? `<label class="opt"><input type="checkbox" id="droppedChk" ${current.dropped ? 'checked' : ''}> Contar abandonados (${droppedCount})</label>` : ''}
        <button class="btn ghost" id="shareBtn" type="button">Compartir resultado</button>
    </div>

    <h2 class="section">Ranking de teams</h2>
    <div id="teams">
        ${sorted.map(([key, d], i) => teamHTML(key, d, i)).join('')}
    </div>

    <h2 class="section">Tus géneros más vistos <small>(top 12)</small></h2>
    ${genreBarsHTML(animes)}
</section>`;

    // Animar barras
    requestAnimationFrame(() => requestAnimationFrame(() => {
        sorted.forEach(([key, d]) => { const f = $(`#fill-${key}`); if (f) f.style.width = d.percent + '%'; });
    }));

    $('#weightChk')?.addEventListener('change', e => {
        current.weighted = e.target.checked;
        store.set('AF_weighted', current.weighted);
        applyFilters();
        renderResult();
    });
    $('#droppedChk')?.addEventListener('change', e => {
        current.dropped = e.target.checked;
        store.set('AF_dropped', current.dropped);
        applyFilters();
        renderResult();
    });
    $('#shareBtn').addEventListener('click', share);
}

function teamHTML(key, d, i) {
    const t = TEAMS[key];
    const genres = t.likes
        .map(g => [g, d.genres[g] || 0])
        .sort((a, b) => b[1] - a[1]);
    return `
<div class="team" id="team-${key}" style="--tc:${t.color};--tc-text:${t.text}">
    <button class="team-head" type="button" data-team="${key}" aria-expanded="false">
        <span class="place${i < 3 ? ' p' + (i + 1) : ''}">${i + 1}</span>
        <span>
            <span class="team-name">${esc(t.name)}</span>
            <div class="track"><div class="fill" id="fill-${key}"></div></div>
        </span>
        <span class="team-pct">${d.percent}%</span>
        <span class="chev">▼</span>
    </button>
    <div class="team-body" hidden>
        <div class="likes">Le gusta: <b>${t.likes.map(esc).join(', ')}</b></div>
        <div class="chips">
            ${genres.map(([g, n]) => `<button type="button" class="chip${n ? '' : ' zero'}" data-team="${key}" data-genre="${esc(g)}" ${n ? '' : 'disabled'}>${esc(g)} <span class="n">${n}</span></button>`).join('')}
        </div>
        <div class="anime-area"></div>
    </div>
</div>`;
}

function genreBarsHTML(animes) {
    const top = genreTotals(animes).slice(0, 12);
    if (!top.length) return '';
    const max = top[0][1];
    const rows = top.map(([g, n]) => {
        const teams = Object.values(TEAMS).filter(t => t.likes.includes(g));
        const segs = (teams.length ? teams.map(t => t.color) : [NO_TEAM_COLOR])
            .map(c => `<i style="flex:1;background:${c}"></i>`).join('');
        return `<div class="gbar"><span class="gname" title="${esc(g)}">${esc(g)}</span>
            <div class="gtrack"><div style="width:${n / max * 100}%;display:flex">${segs}</div></div>
            <span class="gnum">${n}</span></div>`;
    }).join('');
    const legend = Object.values(TEAMS).map(t => `<span><i style="background:${t.color}"></i>${esc(t.name)}</span>`).join('')
        + `<span><i style="background:${NO_TEAM_COLOR}"></i>Ningún team</span>`;
    return `<div class="genre-bars">${rows}<div class="legend">${legend}</div></div>`;
}

function animeCard(a) {
    const inner = `
        <div class="cover">
            ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
            ${a.score > 0 ? `<span class="score">★ ${a.score}</span>` : ''}
        </div>
        <div class="t" title="${esc(a.title)}">${esc(a.title)}</div>`;
    return a.url
        ? `<a class="anime" href="${esc(a.url)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="anime">${inner}</div>`;
}

function showAnimes(teamKey, genre, chip) {
    const area = chip.closest('.team-body').querySelector('.anime-area');
    const wasActive = chip.classList.contains('active');
    chip.parentElement.querySelectorAll('.chip.active').forEach(c => c.classList.remove('active'));
    if (wasActive) { area.innerHTML = ''; return; }
    chip.classList.add('active');

    const seen = new Set();
    const list = (current.affinity[teamKey].animes[genre] || [])
        .filter(a => !seen.has(a.title) && seen.add(a.title))
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    let shown = 0;
    const draw = () => {
        shown += ANIME_PAGE;
        area.innerHTML = `<div class="anime-grid">${list.slice(0, shown).map(animeCard).join('')}</div>`
            + (shown < list.length ? `<div class="more"><button class="btn ghost" type="button">Ver más (${list.length - shown})</button></div>` : '');
        area.querySelector('.more button')?.addEventListener('click', draw);
    };
    draw();
}

// ════════════════════════════════════════════════════════════════
// Compartir / recientes
// ════════════════════════════════════════════════════════════════
async function share() {
    const { username, platform, affinity } = current;
    const sorted = Object.entries(affinity).sort((a, b) => b[1].percent - a[1].percent);
    const url = `${location.origin}${location.pathname}?user=${encodeURIComponent(username)}&platform=${platform}`;
    const text = `Test de afinidad de ${username}: ` + sorted.map(([k, d]) => `${TEAMS[k].name} ${d.percent}%`).join(' · ') + `\n${url}`;
    try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ text });
        else { await navigator.clipboard.writeText(text); toast('Resultado copiado al portapapeles'); }
    } catch {}
}

function saveRecent(username, platform) {
    const list = store.get('AF_recent', []).filter(r => !(r.u.toLowerCase() === username.toLowerCase() && r.p === platform));
    list.unshift({ u: username, p: platform });
    store.set('AF_recent', list.slice(0, 5));
    renderRecent();
}
function renderRecent() {
    const list = store.get('AF_recent', []);
    const el = $('#recent');
    el.hidden = !list.length;
    el.innerHTML = 'Recientes: ' + list.map(r =>
        `<button type="button" data-u="${esc(r.u)}" data-p="${r.p}">${esc(r.u)} <span style="opacity:.6">${r.p === 'mal' ? 'MAL' : 'AL'}</span></button>`).join('');
}

// ════════════════════════════════════════════════════════════════
// Flujo principal
// ════════════════════════════════════════════════════════════════
let busy = false;
async function run() {
    const username = $('#username').value.trim();
    const platform = document.querySelector('input[name=platform]:checked').value;
    if (!username || busy) return;

    busy = true;
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Analizando…';
    renderSkeleton();

    try {
        const all = await fetchList(platform, username);
        current = { username, platform, all, weighted: store.get('AF_weighted', false), dropped: store.get('AF_dropped', false) };
        applyFilters();
        if (!current.animes.length) throw { kind: 'empty' };
        renderResult();
        saveRecent(username, platform);
        history.replaceState(null, '', `?user=${encodeURIComponent(username)}&platform=${platform}`);
    } catch (err) {
        console.error(err);
        renderError(err?.kind ? err : { kind: 'server' }, username);
    } finally {
        busy = false;
        btn.disabled = false;
        btn.textContent = 'Calcular afinidad';
    }
}

// ════════════════════════════════════════════════════════════════
// Eventos
// ════════════════════════════════════════════════════════════════
$('#form').addEventListener('submit', e => { e.preventDefault(); run(); });

document.querySelectorAll('input[name=platform]').forEach(r =>
    r.addEventListener('change', () => store.set('AF_platform', r.value)));

$('#recent').addEventListener('click', e => {
    const b = e.target.closest('button[data-u]');
    if (!b) return;
    $('#username').value = b.dataset.u;
    document.querySelector(`input[name=platform][value=${b.dataset.p}]`).checked = true;
    run();
});

output.addEventListener('click', e => {
    const head = e.target.closest('.team-head');
    if (head) {
        const team = head.parentElement;
        const open = !team.classList.contains('open');
        team.classList.toggle('open', open);
        team.querySelector('.team-body').hidden = !open;
        head.setAttribute('aria-expanded', open);
        return;
    }
    const chip = e.target.closest('.chip:not(.zero)');
    if (chip) showAnimes(chip.dataset.team, chip.dataset.genre, chip);
});

// ════════════════════════════════════════════════════════════════
// Inicio: restaurar plataforma / leer link compartido
// ════════════════════════════════════════════════════════════════
const params = new URLSearchParams(location.search);
const pf = params.get('platform') || store.get('AF_platform');
if (pf === 'mal' || pf === 'anilist') document.querySelector(`input[name=platform][value=${pf}]`).checked = true;
renderRecent();
if (params.get('user')) {
    $('#username').value = params.get('user');
    run();
} else {
    $('#username').focus();
}

});
