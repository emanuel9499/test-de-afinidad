'use strict';

document.addEventListener('DOMContentLoaded', () => {

// ════════════════════════════════════════════════════════════════
// Configuración
// ════════════════════════════════════════════════════════════════
const GENRE_MAP = {
    'Romantic Comedy': 'Romance',
    'Psychological': 'Suspense',
    'Fantasy': 'Fantasia',
    'Cute Girls Doing Cute Things': 'CGDCT'   // etiqueta de AniList → mismo nombre que el tema de MAL
};
const normalizeGenre = g => GENRE_MAP[g] || g;

// core = géneros núcleo (valen CORE_WEIGHT) · extra = también suman (valen 1)
const CORE_WEIGHT = 2;
const TEAMS = {
    yuyo: { name: 'Team Yuyo', color: '#ff6fae', text: '#ffb3d4',
            core: ['Comedy', 'Romance', 'Slice of Life', 'Ecchi', 'CGDCT'], extra: ['Mecha', 'Music', 'Action'] },
    ema:  { name: 'Team Ema',  color: '#6f9bff', text: '#b5ccff',
            core: ['Suspense', 'Horror', 'Drama', 'Sports'], extra: ['Mystery', 'Sci-Fi', 'Mecha', 'Music', 'Action'] },
    eze:  { name: 'Team Eze',  color: '#4fdc9c', text: '#a6f0cd',
            core: ['Adventure', 'Action', 'Fantasia'], extra: ['Isekai'] }
};
Object.values(TEAMS).forEach(t => { t.likes = [...t.core, ...t.extra]; });
const genreWeight = (team, g) => team.core.includes(g) ? CORE_WEIGHT : team.extra.includes(g) ? 1 : 0;

const NO_TEAM_COLOR = '#4a5268';
const ANIME_PAGE = 24;
const PLATFORM_NAME = { mal: 'MyAnimeList', anilist: 'AniList', guest: 'Sin cuenta' };
const MIN_PICKS = 5;

// ════════════════════════════════════════════════════════════════
// Utilidades
// ════════════════════════════════════════════════════════════════
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = s => String(s).replace(/<[^>]+>/g, '');
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
        throw { kind: 'network', username };
    }
    if (res.status === 404) throw { kind: 'notfound', username };
    if (res.status === 403) throw { kind: 'private', username };
    if (res.status === 429) throw { kind: 'ratelimit', username };
    if (!res.ok) throw { kind: 'server', username };
    const data = await res.json();
    return groupFranchises(parseEntries(Array.isArray(data) ? data : (data.animes || data.data || data.list || []), platform));
}

function parseEntries(list, platform) {
    return list
        .filter(a => a && Array.isArray(a.genres))
        .map(a => ({
            id: a.id ?? null,
            mal_id: a.mal_id ?? (platform === 'mal' ? a.id : null),
            plat: platform,
            title: a.title || a.name || 'Sin título',
            image: a.image || a.cover || '',
            genres: [...new Set(a.genres.map(g => normalizeGenre(typeof g === 'string' ? g : g?.name)).filter(Boolean))],
            score: Number(a.score ?? a.user_score ?? a.my_score) || 0,
            status: a.status || 'unknown',
            format: a.format || '',
            start: a.start || null,
            franchise: a.franchise || null,
            url: a.url || null
        }));
}

// ── Franquicias: temporadas, películas, OVAs y specials del mismo anime cuentan UNA vez ──
const STATUS_RANK = { completed: 5, watching: 4, on_hold: 3, dropped: 2, unknown: 1, planning: 0 };
const FORMAT_RANK = { tv: 0, ona: 1, tv_short: 2, movie: 3, ova: 4, special: 5, tv_special: 5 };

function groupFranchises(entries) {
    const groups = new Map();
    entries.forEach(e => {
        const k = e.franchise || `${e.plat}:${e.id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
    });
    return [...groups.values()].map(list => {
        const counted = list.filter(e => e.status !== 'planning');
        const pool = counted.length ? counted : list;
        // Entrada principal: la serie (TV) más antigua
        const rep = [...pool].sort((a, b) =>
            (FORMAT_RANK[a.format] ?? 6) - (FORMAT_RANK[b.format] ?? 6) ||
            String(a.start || '9999').localeCompare(String(b.start || '9999')))[0];
        // Géneros: los de la principal + los que aparecen en al menos la mitad de las entradas
        const freq = {};
        pool.forEach(e => e.genres.forEach(g => { freq[g] = (freq[g] || 0) + 1; }));
        const genres = [...new Set([...rep.genres, ...Object.keys(freq).filter(g => freq[g] >= pool.length / 2)])];
        const scored = pool.filter(e => e.score > 0);
        const score = scored.length ? Math.round(scored.reduce((x, e) => x + e.score, 0) / scored.length * 10) / 10 : 0;
        const status = list.reduce((best, e) => (STATUS_RANK[e.status] ?? 1) > (STATUS_RANK[best] ?? 1) ? e.status : best, 'planning');
        return { ...rep, genres, score, status, entries: list, count: pool.length };
    });
}

// ════════════════════════════════════════════════════════════════
// Cálculo
// ════════════════════════════════════════════════════════════════
const settings = {
    weighted: store.get('AF_weighted', false),
    dropped: store.get('AF_dropped', false)
};

// Peso por puntaje: 10 → x2, 5 → x1, sin puntaje → x1
const scoreWeight = a => settings.weighted && a.score > 0 ? a.score / 5 : 1;

function calculateAffinity(animes) {
    const res = {};
    Object.keys(TEAMS).forEach(k => { res[k] = { raw: 0, genres: {}, contrib: {}, animes: {} }; });
    animes.forEach(anime => {
        const w = scoreWeight(anime);
        anime.genres.forEach(genre => {
            Object.entries(TEAMS).forEach(([key, team]) => {
                const gw = genreWeight(team, genre);
                if (!gw) return;
                const r = res[key];
                r.raw += w * gw;
                r.contrib[genre] = (r.contrib[genre] || 0) + w * gw;
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

// Planeados nunca cuentan; abandonados solo si se elige
function analyze(p) {
    p.animes = p.all.filter(a => a.status !== 'planning' && (settings.dropped || a.status !== 'dropped'));
    p.affinity = calculateAffinity(p.animes);
    p.sorted = Object.entries(p.affinity).sort((a, b) => b[1].percent - a[1].percent || b[1].raw - a[1].raw);
    return p;
}

function genreTotals(animes) {
    const totals = {};
    animes.forEach(a => a.genres.forEach(g => { totals[g] = (totals[g] || 0) + 1; }));
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

// Explicación en texto ("¿por qué este team?")
function explain(p, who = null) {
    const [wk, w] = p.sorted[0];
    const [sk, s] = p.sorted[1];
    const top = Object.entries(w.contrib).sort((a, b) => b[1] - a[1]).slice(0, 2);
    if (!top.length || !w.raw) return '';
    const share = Math.round(top.reduce((x, [, v]) => x + v, 0) / w.raw * 100);
    const genres = top.map(([g]) => `<b>${esc(g)}</b>`).join(' y ');
    const isCore = top.every(([g]) => TEAMS[wk].core.includes(g));
    const owner = who ? `La afinidad de <b>${esc(who)}</b> con` : 'Tu afinidad con';
    let txt = `${owner} <b>${esc(TEAMS[wk].name)}</b> sale sobre todo de ${genres}${isCore ? ', géneros núcleo del team' : ''}: el ${share}% de sus puntos.`;
    const diff = w.percent - s.percent;
    if (diff === 0) txt += ` Empate con <b>${esc(TEAMS[sk].name)}</b>.`;
    else if (diff < 5) txt += ` Pero estuvo reñido: <b>${esc(TEAMS[sk].name)}</b> quedó a solo ${diff} punto${diff === 1 ? '' : 's'}.`;
    else if (diff >= 15) txt += ` Le saca ${diff} puntos a ${esc(TEAMS[sk].name)}, así que no hay dudas.`;
    else txt += ` Le saca ${diff} puntos a ${esc(TEAMS[sk].name)}.`;
    return txt;
}

// ── Comparación ──
const normTitle = t => String(t).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
function keysOf(a) {
    if (a.entries) return a.entries.flatMap(keysOf);
    const k = [];
    if (a.mal_id) k.push('m' + a.mal_id);
    if (a.plat === 'anilist' && a.id) k.push('a' + a.id);
    const t = normTitle(a.title);
    if (t.length > 3) k.push('t' + t);
    return k;
}
function indexList(list) {
    const m = new Map();
    list.forEach(a => keysOf(a).forEach(k => { if (!m.has(k)) m.set(k, a); }));
    return m;
}
function findIn(idx, a) {
    for (const k of keysOf(a)) { const b = idx.get(k); if (b) return b; }
    return null;
}
// Similitud entre dos distribuciones (100 = idénticas)
function similarity(mapA, mapB) {
    const tA = Object.values(mapA).reduce((x, y) => x + y, 0) || 1;
    const tB = Object.values(mapB).reduce((x, y) => x + y, 0) || 1;
    const keys = new Set([...Object.keys(mapA), ...Object.keys(mapB)]);
    let dist = 0;
    keys.forEach(k => { dist += Math.abs((mapA[k] || 0) / tA - (mapB[k] || 0) / tB); });
    return 100 * (1 - dist / 2);
}

function compare(A, B) {
    const idxB = indexList(B.animes);
    const idxBall = indexList(B.all);
    const idxAall = indexList(A.all);

    const shared = [];
    A.animes.forEach(a => { const b = findIn(idxB, a); if (b) shared.push({ a, b }); });
    shared.sort((x, y) => (y.a.score + y.b.score) - (x.a.score + x.b.score) || x.a.title.localeCompare(y.a.title));

    const genreSim = similarity(Object.fromEntries(genreTotals(A.animes)), Object.fromEntries(genreTotals(B.animes)));
    const teamSim = similarity(
        Object.fromEntries(Object.entries(A.affinity).map(([k, d]) => [k, d.percent])),
        Object.fromEntries(Object.entries(B.affinity).map(([k, d]) => [k, d.percent])));
    const compat = Math.round(genreSim * 0.6 + teamSim * 0.4);

    const scored = shared.filter(p => p.a.score > 0 && p.b.score > 0);
    const avgDiff = scored.length ? scored.reduce((x, p) => x + Math.abs(p.a.score - p.b.score), 0) / scored.length : null;

    // Recomendaciones: lo mejor puntuado de uno que el otro no tiene (o solo tiene en planeados)
    const recs = (from, idxTo) => from.animes
        .filter(a => a.score >= 7 && ['completed', 'watching'].includes(a.status))
        .filter(a => { const m = findIn(idxTo, a); return !m || m.status === 'planning'; })
        .sort((x, y) => y.score - x.score)
        .slice(0, 8)
        .map(a => ({ ...a, planned: !!findIn(idxTo, a) }));

    return { shared, compat, genreSim, teamSim, avgDiff, scoredCount: scored.length, recsAtoB: recs(A, idxBall), recsBtoA: recs(B, idxAall) };
}

function compatLabel(c) {
    if (c >= 90) return 'Almas gemelas';
    if (c >= 80) return 'Muy compatibles';
    if (c >= 70) return 'Bastante compatibles';
    if (c >= 55) return 'Algo en común';
    return 'Gustos opuestos';
}

// ════════════════════════════════════════════════════════════════
// Estado
// ════════════════════════════════════════════════════════════════
let current = null;   // { mode: 'single'|'compare', A, B?, cmp? }

// ════════════════════════════════════════════════════════════════
// Render común
// ════════════════════════════════════════════════════════════════
function renderSkeleton() {
    output.innerHTML = `<div class="skel">
        <p class="slow" id="slowNote" hidden>Está tardando más de lo normal: si la lista es grande o el servidor estaba dormido puede demorar hasta un minuto…</p>
        <div style="height:190px"></div>
        <div style="height:66px"></div><div style="height:66px"></div><div style="height:66px"></div>
    </div>`;
}

function renderError(err) {
    const u = `<b>${esc(err.username || '')}</b>`;
    const msgs = {
        notfound: `No encontramos al usuario ${u}. Revisá que esté bien escrito y que sea la plataforma correcta.`,
        private: `La lista de ${u} es privada. Hacela pública para poder analizarla.`,
        ratelimit: 'Hiciste muchas consultas seguidas. Esperá un minuto y probá de nuevo.',
        network: 'No pudimos conectarnos con el servidor. Revisá tu conexión.',
        server: 'El servidor tuvo un problema al buscar la lista. Probá de nuevo en un rato.',
        empty: `La lista de ${u} no tiene animes vistos o en curso para analizar.`
    };
    output.innerHTML = `<div class="msg">${msgs[err.kind] || msgs.server}</div>`;
}

function optionsHTML() {
    const all = current.mode === 'compare' ? [...current.A.all, ...current.B.all] : current.A.all;
    const hasScores = all.some(a => a.score > 0);
    const dropped = all.filter(a => a.status === 'dropped').length;
    return `<div class="actions">
        ${hasScores ? `<label class="opt"><input type="checkbox" data-setting="weighted" ${settings.weighted ? 'checked' : ''}> Ponderar por puntaje</label>` : ''}
        ${dropped ? `<label class="opt"><input type="checkbox" data-setting="dropped" ${settings.dropped ? 'checked' : ''}> Contar abandonados (${dropped})</label>` : ''}
    </div>
    <div class="actions">
        <button class="btn ghost" data-action="image" type="button">🖼 Crear imagen</button>
        <button class="btn ghost" data-action="link" type="button">🔗 Copiar link</button>
    </div>`;
}

function animateBars() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
        output.querySelectorAll('.fill[data-w]').forEach(f => { f.style.width = f.dataset.w + '%'; });
    }));
}

function animeCard(a, extra = '') {
    const inner = `
        <div class="cover">
            ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
            ${a.count > 1 ? `<span class="multi" title="${a.count} entradas de la lista (temporadas, películas, etc.)">×${a.count}</span>` : ''}
            ${extra || (a.score > 0 ? `<span class="score">★ ${a.score}</span>` : '')}
        </div>
        <div class="t" title="${esc(a.title)}">${esc(a.title)}</div>`;
    return a.url
        ? `<a class="anime" href="${esc(a.url)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="anime">${inner}</div>`;
}

// Grilla paginada con "Ver más"
function pagedGrid(area, items, cardFn) {
    let shown = 0;
    const draw = () => {
        shown += ANIME_PAGE;
        area.innerHTML = `<div class="anime-grid">${items.slice(0, shown).map(cardFn).join('')}</div>`
            + (shown < items.length ? `<div class="more"><button class="btn ghost" type="button">Ver más (${items.length - shown})</button></div>` : '');
        area.querySelector('.more button')?.addEventListener('click', draw);
    };
    draw();
}

// ════════════════════════════════════════════════════════════════
// Render individual
// ════════════════════════════════════════════════════════════════
function winnerCard(p, kicker, extra = '') {
    const [wk, w] = p.sorted[0];
    const t = TEAMS[wk];
    return `<div class="winner" style="--tc:${t.color};--tc-text:${t.text}">
        <div class="winner-user">${esc(p.username)} · ${PLATFORM_NAME[p.platform]}</div>
        <div class="kicker">${kicker}</div>
        <div class="name">${esc(t.name)}</div>
        <div class="pct">${w.percent}%</div>
        ${extra}
    </div>`;
}

function renderSingle() {
    const p = current.A;
    const matched = p.animes.filter(a => a.genres.some(g => Object.values(TEAMS).some(t => t.likes.includes(g)))).length;

    output.innerHTML = `
<section class="result">
    ${winnerCard(p, 'Tu team es', `<div class="why">${explain(p)}</div>`)}

    <div class="stats">
        <div class="stat"><div class="k">Animes analizados</div><div class="v">${p.animes.length}</div><div class="sub">${p.animes.reduce((x, a) => x + (a.count || 1), 0)} entradas contando temporadas</div></div>
        <div class="stat"><div class="k">Con géneros de algún team</div><div class="v">${matched}</div></div>
        <div class="stat"><div class="k">Géneros distintos</div><div class="v">${genreTotals(p.animes).length}</div></div>
    </div>

    ${optionsHTML()}

    <h2 class="section">Ranking de teams <small><span class="core-mark">★</span> = género núcleo (vale x${CORE_WEIGHT})</small></h2>
    <div id="teams">${p.sorted.map(([key, d], i) => teamHTML(key, d, i)).join('')}</div>

    <h2 class="section">Tus géneros más vistos <small>(top 12)</small></h2>
    ${genreBarsHTML(p.animes)}
</section>`;
    animateBars();
}

function teamHTML(key, d, i) {
    const t = TEAMS[key];
    const genres = t.likes.map(g => [g, d.genres[g] || 0]).sort((a, b) => genreWeight(t, b[0]) - genreWeight(t, a[0]) || b[1] - a[1]);
    return `
<div class="team" id="team-${key}" style="--tc:${t.color};--tc-text:${t.text}">
    <button class="team-head" type="button" aria-expanded="false">
        <span class="place${i < 3 ? ' p' + (i + 1) : ''}">${i + 1}</span>
        <span>
            <span class="team-name">${esc(t.name)}</span>
            <div class="track"><div class="fill" data-w="${d.percent}"></div></div>
        </span>
        <span class="team-pct">${d.percent}%</span>
        <span class="chev">▼</span>
    </button>
    <div class="team-body" hidden>
        <div class="likes">Núcleo (x${CORE_WEIGHT}): <b>${t.core.map(esc).join(', ')}</b> · También suma: <b>${t.extra.map(esc).join(', ')}</b></div>
        <div class="chips">
            ${genres.map(([g, n]) => `<button type="button" class="chip${n ? '' : ' zero'}" data-team="${key}" data-genre="${esc(g)}" ${n ? '' : 'disabled'}>${t.core.includes(g) ? '<span class="core-mark">★</span>' : ''}${esc(g)} <span class="n">${n}</span></button>`).join('')}
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

function showAnimes(teamKey, genre, chip) {
    const area = chip.closest('.team-body').querySelector('.anime-area');
    const wasActive = chip.classList.contains('active');
    chip.parentElement.querySelectorAll('.chip.active').forEach(c => c.classList.remove('active'));
    if (wasActive) { area.innerHTML = ''; return; }
    chip.classList.add('active');
    const seen = new Set();
    const list = (current.A.affinity[teamKey].animes[genre] || [])
        .filter(a => !seen.has(a.title) && seen.add(a.title))
        .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    pagedGrid(area, list, a => animeCard(a));
}

// ════════════════════════════════════════════════════════════════
// Render comparación
// ════════════════════════════════════════════════════════════════
function renderCompare() {
    const { A, B } = current;
    const c = current.cmp = compare(A, B);
    const sameTeam = A.sorted[0][0] === B.sorted[0][0];

    let text = `${sameTeam
        ? `Los dos son de <b>${esc(TEAMS[A.sorted[0][0]].name)}</b>.`
        : `<b>${esc(A.username)}</b> es de <b>${esc(TEAMS[A.sorted[0][0]].name)}</b> y <b>${esc(B.username)}</b> de <b>${esc(TEAMS[B.sorted[0][0]].name)}</b>.`}
        Tienen <b>${c.shared.length}</b> anime${c.shared.length === 1 ? '' : 's'} en común`;
    if (c.avgDiff != null) text += ` y en los ${c.scoredCount} que ambos puntuaron difieren en promedio <b>${c.avgDiff.toFixed(1)}</b> punto${c.avgDiff.toFixed(1) === '1.0' ? '' : 's'}`;
    text += '.';

    const userLabel = p => `${esc(p.username)}`;
    const dual = Object.keys(TEAMS).map(k => {
        const t = TEAMS[k];
        return `<div class="dual-row" style="--tc:${t.color};--tc-text:${t.text}">
            <div class="tn">${esc(t.name)}</div>
            <div class="dual-bar"><span class="who">${userLabel(A)}</span><div class="track"><div class="fill" data-w="${A.affinity[k].percent}"></div></div><span class="p">${A.affinity[k].percent}%</span></div>
            <div class="dual-bar"><span class="who">${userLabel(B)}</span><div class="track"><div class="fill b" data-w="${B.affinity[k].percent}"></div></div><span class="p">${B.affinity[k].percent}%</span></div>
        </div>`;
    }).join('');

    output.innerHTML = `
<section class="result">
    <div class="duo">
        ${winnerCard(A, 'Team')}
        <div class="compat"><div><div class="k">Compatibilidad</div><div class="v">${c.compat}%</div></div><div class="l">${compatLabel(c.compat)}</div></div>
        ${winnerCard(B, 'Team')}
    </div>
    <p class="compare-text">${text}</p>

    ${optionsHTML()}

    <h2 class="section">Afinidad por team</h2>
    <div class="dual">${dual}</div>

    <h2 class="section">Géneros: quién ve más de qué <small>(% de cada lista)</small></h2>
    ${genreCompareHTML(A, B)}

    <h2 class="section">En común <small>(${c.shared.length})</small></h2>
    <div id="sharedArea">${c.shared.length ? '' : '<p class="empty-note">No tienen ningún anime en común (todavía).</p>'}</div>

    <h2 class="section">Recomendaciones cruzadas</h2>
    <div class="recs">
        ${recsBlock(A, B, c.recsAtoB)}
        ${recsBlock(B, A, c.recsBtoA)}
    </div>

    <h2 class="section">Por qué cada team</h2>
    <p class="compare-text" style="text-align:left">${explain(A, A.username)}<br><br>${explain(B, B.username)}</p>
</section>`;

    if (c.shared.length) {
        pagedGrid($('#sharedArea'), c.shared, ({ a, b }) => animeCard(a,
            (a.score || b.score) ? `<div class="pair-scores"><span title="${esc(A.username)}">${a.score || '–'}</span><span title="${esc(B.username)}">${b.score || '–'}</span></div>` : ''));
    }
    animateBars();
}

function recsBlock(from, to, list) {
    return `<div>
        <h3><b>${esc(from.username)}</b> le recomienda a <b>${esc(to.username)}</b></h3>
        ${list.length
            ? `<div class="anime-grid">${list.map(a => animeCard(a, `<span class="score">★ ${a.score}</span>`)).join('')}</div>`
            : `<p class="empty-note">${from.all.some(a => a.score > 0) ? 'No hay animes bien puntuados que el otro no haya visto.' : 'Hace falta que puntúe sus animes para recomendar.'}</p>`}
    </div>`;
}

function genreCompareHTML(A, B) {
    const tA = Object.fromEntries(genreTotals(A.animes)), tB = Object.fromEntries(genreTotals(B.animes));
    const nA = A.animes.length || 1, nB = B.animes.length || 1;
    const rows = [...new Set([...Object.keys(tA), ...Object.keys(tB)])]
        .map(g => [g, (tA[g] || 0) / nA * 100, (tB[g] || 0) / nB * 100])
        .sort((x, y) => (y[1] + y[2]) - (x[1] + x[2]))
        .slice(0, 10);
    if (!rows.length) return '';
    const max = Math.max(...rows.flatMap(r => [r[1], r[2]]));
    const colorOf = g => (Object.values(TEAMS).find(t => t.core.includes(g)) || Object.values(TEAMS).find(t => t.likes.includes(g)))?.color || NO_TEAM_COLOR;
    return `<div class="gcmp">
        <div class="gcmp-head"><span>${esc(A.username)}</span><span>Género</span><span>${esc(B.username)}</span></div>
        ${rows.map(([g, a, b]) => `<div class="gcmp-row">
            <span class="n">${Math.round(a)}%</span>
            <div class="half l"><i style="width:${a / max * 100}%;background:${colorOf(g)}"></i></div>
            <span class="g" title="${esc(g)}">${esc(g)}</span>
            <div class="half"><i style="width:${b / max * 100}%;background:${colorOf(g)};opacity:.6"></i></div>
            <span class="n r">${Math.round(b)}%</span>
        </div>`).join('')}
    </div>`;
}

function render() {
    if (current.mode === 'compare') renderCompare();
    else renderSingle();
}

// ════════════════════════════════════════════════════════════════
// Imagen para compartir (canvas 1080×1350)
// ════════════════════════════════════════════════════════════════
const W = 1080, H = 1350;

function rr(x, X, Y, w, h, r) {
    x.beginPath();
    if (x.roundRect) x.roundRect(X, Y, w, h, r);
    else { x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
}
function font(x, weight, size) { x.font = `${weight} ${size}px Outfit, system-ui, sans-serif`; }
function fit(x, text, maxW) {
    if (x.measureText(text).width <= maxW) return text;
    while (text.length > 1 && x.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
}
function wrap(x, text, X, Y, maxW, lh, maxLines) {
    const words = text.split(' ');
    let line = '', lines = [];
    words.forEach(w => {
        const test = line ? line + ' ' + w : w;
        if (x.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    });
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = fit(x, lines[maxLines - 1] + '…', maxW); }
    lines.forEach((l, i) => x.fillText(l, X, Y + i * lh));
}
function setSpacing(x, v) { if ('letterSpacing' in x) x.letterSpacing = v; }

function baseCanvas() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#0b0d13';
    x.fillRect(0, 0, W, H);
    [[120, -40, 800, 'rgba(255,165,61,.22)'], [1020, 80, 760, 'rgba(122,162,255,.16)']].forEach(([cx, cy, r, col]) => {
        const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
        x.fillStyle = g; x.fillRect(0, 0, W, H);
    });
    x.textBaseline = 'alphabetic';
    // encabezado
    x.textAlign = 'center';
    font(x, 600, 30); setSpacing(x, '6px'); x.fillStyle = '#ffc98a';
    x.fillText('TEST DE AFINIDAD DE ANIME', W / 2, 100);
    setSpacing(x, '0px');
    // pie
    font(x, 400, 26); x.fillStyle = '#7c869e';
    x.fillText(`Hacé el test en ${location.host}`, W / 2, H - 50);
    return [c, x];
}

function teamPanel(x, X, Y, w, h, t) {
    const g = x.createLinearGradient(X, Y, X + w, Y + h);
    g.addColorStop(0, t.color + '55'); g.addColorStop(.7, '#131722');
    rr(x, X, Y, w, h, 36); x.fillStyle = g; x.fill();
    x.lineWidth = 3; x.strokeStyle = t.color + '99'; x.stroke();
}

function bar(x, X, Y, w, h, pct, color, alpha = 1) {
    rr(x, X, Y, w, h, h / 2); x.fillStyle = 'rgba(255,255,255,.08)'; x.fill();
    if (pct > 0) { x.globalAlpha = alpha; rr(x, X, Y, Math.max(h, w * pct / 100), h, h / 2); x.fillStyle = color; x.fill(); x.globalAlpha = 1; }
}

function drawSingle() {
    const [c, x] = baseCanvas();
    const p = current.A;
    const [wk, w] = p.sorted[0];
    const t = TEAMS[wk];

    font(x, 500, 36); x.fillStyle = '#eef1f7';
    x.fillText(fit(x, `${p.username} · ${PLATFORM_NAME[p.platform]}`, 900), W / 2, 160);

    teamPanel(x, 80, 210, 920, 430, t);
    font(x, 600, 28); setSpacing(x, '5px'); x.fillStyle = '#a3acc0';
    x.fillText('MI TEAM ES', W / 2, 290); setSpacing(x, '0px');
    font(x, 800, 100); x.fillStyle = t.text;
    x.fillText(fit(x, t.name, 860), W / 2, 405);
    font(x, 800, 150); x.fillStyle = '#ffffff';
    x.fillText(`${w.percent}%`, W / 2, 575);

    p.sorted.forEach(([k, d], i) => {
        const tt = TEAMS[k], y = 720 + i * 105;
        x.textAlign = 'left'; font(x, 700, 34); x.fillStyle = tt.text; x.fillText(tt.name, 80, y);
        x.textAlign = 'right'; font(x, 800, 34); x.fillStyle = '#ffffff'; x.fillText(`${d.percent}%`, 1000, y);
        bar(x, 80, y + 20, 920, 24, d.percent, tt.color);
    });

    x.textAlign = 'center'; font(x, 400, 30); x.fillStyle = '#d5dbe8';
    wrap(x, stripTags(explain(p)), W / 2, 1080, 900, 42, 4);
    return c;
}

function drawCompare() {
    const [c, x] = baseCanvas();
    const { A, B, cmp } = current;

    [[A, 290], [B, 790]].forEach(([p, cx]) => {
        const [wk, w] = p.sorted[0], t = TEAMS[wk];
        teamPanel(x, cx - 230, 150, 460, 330, t);
        x.textAlign = 'center';
        font(x, 500, 32); x.fillStyle = '#eef1f7'; x.fillText(fit(x, p.username, 410), cx, 215);
        font(x, 800, 58); x.fillStyle = t.text; x.fillText(fit(x, t.name, 420), cx, 320);
        font(x, 800, 96); x.fillStyle = '#ffffff'; x.fillText(`${w.percent}%`, cx, 435);
    });

    rr(x, 80, 520, 920, 210, 36); x.fillStyle = '#131722'; x.fill();
    x.lineWidth = 3; x.strokeStyle = 'rgba(255,165,61,.55)'; x.stroke();
    x.textAlign = 'center';
    font(x, 600, 26); setSpacing(x, '5px'); x.fillStyle = '#a3acc0'; x.fillText('COMPATIBILIDAD', W / 2, 575); setSpacing(x, '0px');
    const g = x.createLinearGradient(380, 0, 700, 0); g.addColorStop(0, '#ffd27a'); g.addColorStop(1, '#ff7a45');
    font(x, 800, 96); x.fillStyle = g; x.fillText(`${cmp.compat}%`, W / 2, 655);
    font(x, 500, 28); x.fillStyle = '#ffd9b0'; x.fillText(compatLabel(cmp.compat), W / 2, 702);

    Object.keys(TEAMS).forEach((k, i) => {
        const t = TEAMS[k], y = 790 + i * 115;
        x.textAlign = 'left'; font(x, 700, 32); x.fillStyle = t.text; x.fillText(t.name, 80, y);
        x.textAlign = 'right'; font(x, 600, 28); x.fillStyle = '#d5dbe8';
        x.fillText(`${A.affinity[k].percent}% · ${B.affinity[k].percent}%`, 1000, y);
        bar(x, 80, y + 16, 920, 18, A.affinity[k].percent, t.color);
        bar(x, 80, y + 42, 920, 18, B.affinity[k].percent, t.color, .55);
    });

    x.textAlign = 'center'; font(x, 500, 32); x.fillStyle = '#eef1f7';
    x.fillText(`${cmp.shared.length} anime${cmp.shared.length === 1 ? '' : 's'} en común`, W / 2, 1180);
    if (cmp.avgDiff != null) {
        font(x, 400, 26); x.fillStyle = '#a3acc0';
        x.fillText(`En los que ambos puntuaron difieren ${cmp.avgDiff.toFixed(1)} puntos en promedio`, W / 2, 1222);
    }
    font(x, 400, 22); x.fillStyle = '#7c869e';
    x.fillText(`Barra llena: ${fit(x, A.username, 300)} · Barra clara: ${fit(x, B.username, 300)}`, W / 2, 1258);
    return c;
}

let imgBlob = null, imgURL = null;
async function openImage() {
    try { await document.fonts.load('800 40px Outfit'); await document.fonts.load('400 40px Outfit'); } catch {}
    const canvas = current.mode === 'compare' ? drawCompare() : drawSingle();
    imgBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (imgURL) URL.revokeObjectURL(imgURL);
    imgURL = URL.createObjectURL(imgBlob);
    $('#imgPreview').src = imgURL;
    const file = new File([imgBlob], fileName(), { type: 'image/png' });
    $('#imgShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('#imgCopy').hidden = !(window.ClipboardItem && navigator.clipboard?.write);
    $('#imgModal').hidden = false;
}
const fileName = () => current.mode === 'compare'
    ? `afinidad-${current.A.username}-vs-${current.B.username}.png`
    : `afinidad-${current.A.username}.png`;

// ════════════════════════════════════════════════════════════════
// Links / recientes
// ════════════════════════════════════════════════════════════════
function shareURL() {
    const q = new URLSearchParams({ user: current.A.username, platform: current.A.platform });
    if (current.A.platform === 'guest') q.set('picks', encodePicks(1));
    if (current.mode === 'compare') {
        q.set('user2', current.B.username); q.set('platform2', current.B.platform);
        if (current.B.platform === 'guest') q.set('picks2', encodePicks(2));
    }
    return `${location.origin}${location.pathname}?${q}`;
}

function saveRecent(username, platform) {
    const list = store.get('AF_recent', []).filter(r => !(r.u.toLowerCase() === username.toLowerCase() && r.p === platform));
    list.unshift({ u: username, p: platform });
    store.set('AF_recent', list.slice(0, 6));
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
const radioVal = name => document.querySelector(`input[name=${name}]:checked`).value;
const setRadio = (name, v) => { const r = document.querySelector(`input[name=${name}][value=${v}]`); if (r) r.checked = true; };
const compareOn = () => !$('#row2').hidden;

let busy = false;
async function run() {
    if (busy) return;
    const p1 = radioVal('platform');
    const p2 = radioVal('platform2');
    const cmp = compareOn();
    const u1 = $('#username').value.trim() || (p1 === 'guest' ? 'Invitado' : '');
    const u2 = cmp ? ($('#username2').value.trim() || (p2 === 'guest' ? 'Invitado 2' : '')) : '';
    if (!u1) { $('#username').focus(); return; }
    if (cmp && !u2) { $('#username2').focus(); return; }
    for (const [row, plat] of [[1, p1], [2, cmp ? p2 : null]]) {
        if (plat === 'guest' && picks[row].size < MIN_PICKS) {
            toast(`Elegí al menos ${MIN_PICKS} animes${cmp ? (row === 1 ? ' para el primer usuario' : ' para el segundo usuario') : ''}`);
            openPicker(row);
            return;
        }
    }

    busy = true;
    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Analizando…';
    renderSkeleton();
    const slowT = setTimeout(() => { const n = $('#slowNote'); if (n) n.hidden = false; }, 7000);

    try {
        const jobs = [getList(1, p1, u1)];
        if (u2) jobs.push(getList(2, p2, u2));
        const [l1, l2] = await Promise.all(jobs);

        const A = analyze({ username: u1, platform: p1, all: l1 });
        if (!A.animes.length) throw { kind: 'empty', username: u1 };
        let B = null;
        if (u2) {
            B = analyze({ username: u2, platform: p2, all: l2 });
            if (!B.animes.length) throw { kind: 'empty', username: u2 };
        }
        current = B ? { mode: 'compare', A, B } : { mode: 'single', A };
        render();
        if (p1 !== 'guest') saveRecent(u1, p1);
        if (u2 && p2 !== 'guest') saveRecent(u2, p2);
        renderRecent();
        history.replaceState(null, '', shareURL().replace(location.origin, ''));
    } catch (err) {
        console.error(err);
        renderError(err?.kind ? err : { kind: 'server' });
    } finally {
        clearTimeout(slowT);
        busy = false;
        btn.disabled = false;
        btn.textContent = u2 ? 'Comparar' : 'Calcular afinidad';
    }
}

function setCompare(on) {
    $('#row2').hidden = !on;
    $('#addCompare').hidden = on;
    $('#submitBtn').textContent = on ? 'Comparar' : 'Calcular afinidad';
    if (on) $('#username2').focus();
}

// ════════════════════════════════════════════════════════════════
// Sin cuenta: elegir animes de una grilla de populares + búsqueda
// ════════════════════════════════════════════════════════════════
const picks = { 1: new Map(), 2: new Map() };   // id → { level: 1 (visto) | 2 (favorito), title, image }
let pickRow = 1;
let popular = null;

function getList(row, platform, username) {
    return platform === 'guest' ? fetchGuest(row) : fetchList(platform, username);
}

async function fetchGuest(row) {
    const ids = [...picks[row].keys()];
    let res;
    try { res = await fetch(`/api/media?ids=${ids.join(',')}`); } catch { throw { kind: 'network' }; }
    if (res.status === 429) throw { kind: 'ratelimit' };
    if (!res.ok) throw { kind: 'server' };
    const data = await res.json();
    data.forEach(m => {
        const p = picks[row].get(m.id);
        if (p) { m.score = p.level === 2 ? 10 : 0; if (!p.title) { p.title = m.title_en || m.title; p.image = m.image; } }
    });
    return groupFranchises(parseEntries(data, 'anilist'));
}

const encodePicks = row => [...picks[row]].map(([id, p]) => (p.level === 2 ? '*' : '') + id).join('.');
function decodePicks(row, str) {
    picks[row].clear();
    String(str || '').split('.').forEach(tok => {
        const fav = tok.startsWith('*');
        const id = parseInt(fav ? tok.slice(1) : tok);
        if (id > 0) picks[row].set(id, { level: fav ? 2 : 1, title: '', image: '' });
    });
}

// Ajusta la fila según la plataforma elegida
function syncRow(row) {
    const plat = radioVal(row === 1 ? 'platform' : 'platform2');
    const input = $(row === 1 ? '#username' : '#username2');
    const btn = $('#pickBtn' + row);
    const guest = plat === 'guest';
    input.placeholder = guest ? (row === 1 ? 'Tu nombre (opcional)' : 'Su nombre (opcional)') : (row === 1 ? 'Tu username' : 'Username a comparar');
    btn.hidden = !guest;
    const n = picks[row].size;
    btn.textContent = n ? `Elegir animes (${n})` : 'Elegir animes';
    btn.classList.toggle('has', n > 0);
}

async function openPicker(row) {
    pickRow = row;
    $('#pickSearch').value = '';
    $('#pickModal').hidden = false;
    updatePickCount();
    if (!popular) {
        $('#pickGrid').innerHTML = '<p class="picker-section">Cargando populares…</p>';
        try {
            const r = await fetch('/api/popular');
            popular = r.ok ? await r.json() : [];
        } catch { popular = []; }
    }
    drawPicker(null);
}

function pickCard(m) {
    const p = picks[pickRow].get(m.id);
    const lvl = p ? p.level : 0;
    return `<button type="button" class="pcard l${lvl}" data-id="${m.id}" data-title="${esc(m.title)}" data-image="${esc(m.image)}">
        <div class="cover">${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : ''}<span class="mark">${lvl === 2 ? '❤' : '✓'}</span></div>
        <div class="t">${esc(m.title)}${m.year ? ` <span style="color:var(--dim)">(${m.year})</span>` : ''}</div>
    </button>`;
}

function drawPicker(results) {
    const grid = $('#pickGrid');
    if (results) {
        grid.innerHTML = results.length
            ? `<div class="picker-section">Resultados</div>${results.map(pickCard).join('')}`
            : '<p class="picker-section">Sin resultados</p>';
        return;
    }
    const popIds = new Set((popular || []).map(m => m.id));
    const extra = [...picks[pickRow]].filter(([id]) => !popIds.has(id)).map(([id, p]) => ({ id, title: p.title || 'Anime #' + id, image: p.image }));
    grid.innerHTML =
        (extra.length ? `<div class="picker-section">Agregados por vos</div>${extra.map(pickCard).join('')}` : '') +
        `<div class="picker-section">Populares</div>${(popular || []).map(pickCard).join('')}`;
}

function updatePickCount() {
    const list = [...picks[pickRow].values()];
    const fav = list.filter(p => p.level === 2).length;
    $('#pickCount').textContent = `${list.length} elegido${list.length === 1 ? '' : 's'}${fav ? ` · ${fav} ❤` : ''}${list.length < MIN_PICKS ? ` (mínimo ${MIN_PICKS})` : ''}`;
}

$('#pickGrid').addEventListener('click', e => {
    const card = e.target.closest('.pcard');
    if (!card) return;
    const id = +card.dataset.id;
    const map = picks[pickRow];
    const lvl = ((map.get(id)?.level || 0) + 1) % 3;
    if (lvl === 0) map.delete(id);
    else map.set(id, { level: lvl, title: card.dataset.title, image: card.dataset.image });
    card.className = `pcard l${lvl}`;
    card.querySelector('.mark').textContent = lvl === 2 ? '❤' : '✓';
    updatePickCount();
});

let searchT = null, searchSeq = 0;
$('#pickSearch').addEventListener('input', e => {
    clearTimeout(searchT);
    const q = e.target.value.trim();
    if (q.length < 2) { drawPicker(null); return; }
    searchT = setTimeout(async () => {
        const seq = ++searchSeq;
        try {
            const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
            const list = r.ok ? await r.json() : [];
            if (seq === searchSeq) drawPicker(list);
        } catch { if (seq === searchSeq) drawPicker([]); }
    }, 400);
});
$('#pickSearch').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });

const closePicker = () => { $('#pickModal').hidden = true; syncRow(1); syncRow(2); };
$('#pickDone').addEventListener('click', closePicker);
$('#pickClear').addEventListener('click', () => { picks[pickRow].clear(); updatePickCount(); drawPicker(null); });
$('#pickModal').addEventListener('click', e => { if (e.target.id === 'pickModal') closePicker(); });
document.querySelectorAll('.pick-btn').forEach(b => b.addEventListener('click', () => openPicker(+b.dataset.row)));
document.querySelectorAll('input[name=platform], input[name=platform2]').forEach(r =>
    r.addEventListener('change', () => { syncRow(1); syncRow(2); }));

// ════════════════════════════════════════════════════════════════
// Eventos
// ════════════════════════════════════════════════════════════════
$('#form').addEventListener('submit', e => { e.preventDefault(); run(); });
$('#addCompare').addEventListener('click', () => setCompare(true));
$('#removeRow2').addEventListener('click', () => { $('#username2').value = ''; setCompare(false); });

document.querySelectorAll('input[name=platform]').forEach(r =>
    r.addEventListener('change', () => store.set('AF_platform', r.value)));

// Recientes: completa el primer campo vacío
$('#recent').addEventListener('click', e => {
    const b = e.target.closest('button[data-u]');
    if (!b) return;
    if (compareOn() && $('#username').value.trim() && !$('#username2').value.trim()) {
        $('#username2').value = b.dataset.u; setRadio('platform2', b.dataset.p); syncRow(2);
        $('#username2').focus();
    } else {
        $('#username').value = b.dataset.u; setRadio('platform', b.dataset.p); syncRow(1);
        if (!compareOn()) run();
    }
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
    if (chip) return showAnimes(chip.dataset.team, chip.dataset.genre, chip);

    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'image') openImage();
    if (action === 'link') navigator.clipboard?.writeText(shareURL()).then(() => toast('Link copiado'), () => toast('No se pudo copiar'));
});

output.addEventListener('change', e => {
    const key = e.target.dataset?.setting;
    if (!key) return;
    settings[key] = e.target.checked;
    store.set(key === 'weighted' ? 'AF_weighted' : 'AF_dropped', settings[key]);
    analyze(current.A);
    if (current.B) analyze(current.B);
    render();
});

// Modal de imagen
const closeModal = () => { $('#imgModal').hidden = true; };
$('#imgClose').addEventListener('click', closeModal);
$('#imgModal').addEventListener('click', e => { if (e.target.id === 'imgModal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); if (!$('#pickModal').hidden) closePicker(); } });
$('#imgDownload').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = imgURL; a.download = fileName(); a.click();
});
$('#imgCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': imgBlob })]); toast('Imagen copiada'); }
    catch { toast('Tu navegador no permite copiar imágenes'); }
});
$('#imgShare').addEventListener('click', async () => {
    try { await navigator.share({ files: [new File([imgBlob], fileName(), { type: 'image/png' })], text: shareURL() }); } catch {}
});

// ════════════════════════════════════════════════════════════════
// Inicio: restaurar plataforma / leer link compartido
// ════════════════════════════════════════════════════════════════
const params = new URLSearchParams(location.search);
const VALID = ['mal', 'anilist', 'guest'];
const pf = params.get('platform') || store.get('AF_platform');
if (VALID.includes(pf)) setRadio('platform', pf);
if (params.get('picks')) decodePicks(1, params.get('picks'));
if (params.get('picks2')) decodePicks(2, params.get('picks2'));
renderRecent();
syncRow(1); syncRow(2);
if (params.get('user')) {
    $('#username').value = params.get('user');
    if (params.get('user2')) {
        setCompare(true);
        $('#username2').value = params.get('user2');
        const pf2 = params.get('platform2');
        if (VALID.includes(pf2)) setRadio('platform2', pf2);
    }
    run();
} else {
    $('#username').focus();
}

});
