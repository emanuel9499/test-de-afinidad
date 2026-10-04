import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ⚡ Servir frontend desde la carpeta public
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Para mantener el servidor despierto (pinguear cada 10 min desde cron-job.org o similar)
app.get("/health", (req, res) => res.send("ok"));

// Client ID de MAL: configurarlo en Render → Environment → MAL_CLIENT_ID
// (el valor de respaldo se puede borrar una vez configurada la variable)
const CLIENT_ID = process.env.MAL_CLIENT_ID || "b35acc338b1fcf0fab6188e73e5cb797";

const http = axios.create({ timeout: 20000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAY = 24 * 60 * 60 * 1000;

// ---------------- Caché en memoria ----------------
const cache = new Map();
function getCached(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() > c.exp) { cache.delete(key); return null; }
  return c.data;
}
function setCached(key, data, ttl = 10 * 60 * 1000) {
  cache.set(key, { exp: Date.now() + ttl, data });
  if (cache.size > 400) cache.delete(cache.keys().next().value);
}

// ---------------- Límite por IP ----------------
const hits = new Map();
const rateLimit = (max, bucket) => (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  const key = bucket + ":" + ip;
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < 60000);
  if (list.length >= max) return res.status(429).json({ error: "Demasiadas consultas, esperá un minuto." });
  list.push(now);
  hits.set(key, list);
  next();
};
const listLimit = rateLimit(20, "list");
const searchLimit = rateLimit(60, "search");
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some(t => now - t < 60000)) hits.delete(k);
}, 5 * 60000).unref();

// Respuesta de error uniforme
function sendError(res, status, label, error) {
  console.error(`ERROR ${label}:`, error?.response?.data || error?.message || error);
  const code = [403, 404, 429].includes(status) ? status : 502;
  res.status(code).json({ error: label });
}

// ================================================================
// AniList: cola global (todas las consultas del servidor pasan por acá
// para no superar su límite de ~30/min)
// ================================================================
let alChain = Promise.resolve();
let alNext = 0;
function alQuery(query, variables) {
  const p = alChain.then(async () => {
    const wait = alNext - Date.now();
    if (wait > 0) await sleep(wait);
    alNext = Date.now() + 2000;   // ≈30 req/min
    try {
      const r = await http.post("https://graphql.anilist.co", { query, variables },
        { headers: { "Content-Type": "application/json", Accept: "application/json" } });
      return r.data;
    } catch (e) {
      if (e.response?.status === 429) {
        const ra = parseInt(e.response.headers?.["retry-after"]) || 60;
        alNext = Date.now() + ra * 1000;   // pausa global
      }
      throw e;
    }
  });
  alChain = p.catch(() => {});
  return p;
}

// ================================================================
// Franquicias: agrupar temporadas / películas / OVAs / specials
// ================================================================
// Relaciones de AniList que indican "mismo anime"
const SAME_FRANCHISE = new Set(["PREQUEL", "SEQUEL", "PARENT", "SIDE_STORY", "SUMMARY", "ALTERNATIVE", "COMPILATION"]);
const franchiseEdges = media => (media?.relations?.edges || [])
  .filter(e => SAME_FRANCHISE.has(e.relationType) && e.node?.type === "ANIME")
  .map(e => e.node);

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

// Título "base" (respaldo cuando no hay relaciones): "Shingeki no Kyojin Season 3 Part 2" → "shingekinokyojin"
function baseTitle(t) {
  let s = String(t || "").toLowerCase().replace(/\bgekij[oō]u?ban\b/g, " ");
  s = s.split(/[:?!] | - | ~/)[0];
  s = s
    .replace(/\b(the )?(final )?season\b.*$/, "")
    .replace(/\b\d+(st|nd|rd|th)\b.*$/, "")
    .replace(/\b(part|cour|movie|film|ova|ona|specials?|recap|picture drama)\b.*$/, "")
    .replace(/\b(ii|iii|iv|v|vi)\s*$/, "")
    .replace(/\s\d+\s*$/, "");
  return s.replace(/[^a-z0-9]/g, "");
}

// entries: [{ node, rels: [nodes] | null, title }] → asigna e.franchise
function assignFranchises(entries) {
  const uf = new UnionFind();
  entries.forEach(e => {
    uf.find(e.node);
    (e.rels || []).forEach(r => uf.union(e.node, r));
  });
  // Respaldo por título para las que AniList no conoce
  const byBase = new Map();
  entries.forEach(e => { const b = baseTitle(e.title); if (b.length >= 4 && !byBase.has(b)) byBase.set(b, e.node); });
  entries.filter(e => e.rels == null).forEach(e => {
    const b = baseTitle(e.title);
    if (b.length >= 4) uf.union(e.node, byBase.get(b));
  });
  entries.forEach(e => { e.franchise = uf.find(e.node); });
}

// Relaciones por ID de MAL (consultadas a AniList en tandas de 50, cacheadas 7 días)
const relCache = new Map();   // idMal → { t, rel: [idMal] | null }
const REL_QUERY = `query ($ids: [Int]) {
  Page(page: 1, perPage: 50) {
    media(idMal_in: $ids, type: ANIME) { idMal relations { edges { relationType node { idMal type } } } }
  }
}`;
async function malRelations(ids) {
  const out = new Map();
  const missing = [];
  ids.forEach(id => {
    const c = relCache.get(id);
    if (c && Date.now() - c.t < 7 * DAY) out.set(id, c.rel); else missing.push(id);
  });
  for (let i = 0; i < missing.length && i < 2000; i += 50) {
    const chunk = missing.slice(i, i + 50);
    try {
      const d = await alQuery(REL_QUERY, { ids: chunk });
      const found = new Set();
      (d?.data?.Page?.media || []).forEach(m => {
        const rel = franchiseEdges(m).map(n => n.idMal).filter(Boolean);
        found.add(m.idMal);
        relCache.set(m.idMal, { t: Date.now(), rel });
        out.set(m.idMal, rel);
      });
      chunk.filter(id => !found.has(id)).forEach(id => { relCache.set(id, { t: Date.now(), rel: null }); out.set(id, null); });
    } catch (e) {
      console.error("Relaciones AniList:", e.response?.status || e.message);
      break;   // lo que falte se agrupa por título
    }
  }
  if (relCache.size > 30000) [...relCache.keys()].slice(0, 5000).forEach(k => relCache.delete(k));
  return out;
}

// ================================================================
// Normalización
// ================================================================
const AL_STATUS = { CURRENT: "watching", REPEATING: "watching", COMPLETED: "completed", PAUSED: "on_hold", DROPPED: "dropped", PLANNING: "planning" };
// Etiquetas de AniList que el test usa como géneros → nombre equivalente en MAL
const AL_TAGS = {
  "Isekai": "Isekai", "Cute Girls Doing Cute Things": "CGDCT", "Iyashikei": "Iyashikei",
  "Female Harem": "Harem", "Male Harem": "Harem", "Mixed Gender Harem": "Harem",
  "Love Triangle": "Love Polygon", "School": "School", "Idol": "Idols", "Food": "Gourmet",
  "Yuri": "Girls Love", "Otaku Culture": "Otaku Culture", "Boys' Love": "Boys Love",
  "Detective": "Detective", "Gore": "Gore", "Survival": "Survival", "Death Game": "High Stakes Game",
  "Team Sports": "Sports", "Combat Sports": "Sports", "Adult Cast": "Adult Cast"
};
const MEDIA_FIELDS = `id idMal title { romaji english } format startDate { year month day }
  genres tags { name rank } coverImage { large }
  relations { edges { relationType node { id idMal type } } }`;

const dateKey = (y, m, d) => y ? `${y}-${String(m || 1).padStart(2, "0")}-${String(d || 1).padStart(2, "0")}` : null;

function normalizeAL(m) {
  const tags = (m.tags || []).filter(t => AL_TAGS[t.name] && t.rank >= 60).map(t => AL_TAGS[t.name]);
  return {
    id: m.id,
    mal_id: m.idMal || null,
    title: m.title?.romaji || m.title?.english || "Sin título",
    title_en: m.title?.english || null,
    genres: [...new Set([...(m.genres || []), ...tags])],
    image: m.coverImage?.large || "",
    format: (m.format || "").toLowerCase(),
    start: dateKey(m.startDate?.year, m.startDate?.month, m.startDate?.day),
    url: `https://anilist.co/anime/${m.id}`
  };
}
// Agrupa una lista normalizada de AniList usando sus propias relaciones
function groupAniList(items, medias) {
  const entries = items.map((it, i) => ({ it, node: "a" + it.id, rels: medias[i].relations ? franchiseEdges(medias[i]).map(n => "a" + n.id) : null, title: it.title }));
  assignFranchises(entries);
  entries.forEach(e => { e.it.franchise = e.franchise; });
}

// ================================================================
// MAL
// ================================================================
app.get("/api/mal/:username", listLimit, async (req, res) => {
  const username = req.params.username.trim();
  const key = "mal:" + username.toLowerCase();
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    const animes = [];
    let url = `https://api.myanimelist.net/v2/users/${encodeURIComponent(username)}/animelist`;
    let params = { limit: 1000, nsfw: true, fields: "list_status,genres,main_picture,media_type,start_date" };

    for (let page = 0; url && page < 10; page++) {
      const r = await http.get(url, { headers: { "X-MAL-CLIENT-ID": CLIENT_ID }, params });
      for (const item of r.data.data || []) {
        const n = item.node;
        const ls = item.list_status || {};
        animes.push({
          id: n.id,
          mal_id: n.id,
          title: n.title,
          genres: (n.genres || []).map(g => g.name),
          image: n.main_picture?.medium || n.main_picture?.large || "",
          format: n.media_type || "",
          start: n.start_date || null,
          status: ls.status === "plan_to_watch" ? "planning" : ls.status || "unknown",
          score: ls.score || 0,
          url: `https://myanimelist.net/anime/${n.id}`
        });
      }
      url = r.data.paging?.next || null;   // la URL "next" ya trae los parámetros
      params = undefined;
    }

    // Agrupar temporadas/películas/OVAs del mismo anime
    const rels = await malRelations(animes.map(a => a.mal_id));
    const entries = animes.map(a => {
      const r = rels.get(a.mal_id);
      return { a, node: "m" + a.mal_id, rels: r == null ? null : r.map(id => "m" + id), title: a.title };
    });
    assignFranchises(entries);
    entries.forEach(e => { e.a.franchise = e.franchise; });

    setCached(key, animes);
    res.json(animes);
  } catch (error) {
    sendError(res, error.response?.status, "MAL", error);
  }
});

// ================================================================
// AniList
// ================================================================
function listQuery(withRelations) {
  const fields = withRelations ? MEDIA_FIELDS : MEDIA_FIELDS.replace(/relations \{[^]*$/, "");
  return `query ($username: String) {
    MediaListCollection(userName: $username, type: ANIME) {
      lists { entries { status score(format: POINT_10) media { ${fields} } } }
    }
  }`;
}

app.get("/api/anilist/:username", listLimit, async (req, res) => {
  const username = req.params.username.trim();
  const key = "al:" + username.toLowerCase();
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    let data;
    try {
      data = await alQuery(listQuery(true), { username });
    } catch (e) {
      // Si la consulta con relaciones es demasiado pesada, la repetimos sin ellas (agrupa por título)
      if (e.response?.status === 400 || e.response?.status === 413) data = await alQuery(listQuery(false), { username });
      else throw e;
    }

    const lists = data?.data?.MediaListCollection?.lists || [];
    const seen = new Set();
    const items = [], medias = [];
    lists.forEach(list => list.entries.forEach(e => {
      if (!e.media || seen.has(e.media.id)) return;   // un anime puede estar en varias listas personalizadas
      seen.add(e.media.id);
      items.push({ ...normalizeAL(e.media), status: AL_STATUS[e.status] || "unknown", score: e.score || 0 });
      medias.push(e.media);
    }));
    groupAniList(items, medias);

    setCached(key, items);
    res.json(items);
  } catch (error) {
    const msg = JSON.stringify(error.response?.data?.errors || "");
    const status = /private/i.test(msg) ? 403 : /not found/i.test(msg) ? 404 : error.response?.status;
    sendError(res, status, "AniList", error);
  }
});

// ================================================================
// Sin cuenta: populares, búsqueda y datos de los animes elegidos
// ================================================================
const pick = m => ({ id: m.id, title: m.title?.english || m.title?.romaji, image: m.coverImage?.large || "", format: (m.format || "").toLowerCase(), year: m.startDate?.year || null });

// Animes populares, solo la "primera" entrada de cada franquicia
app.get("/api/popular", searchLimit, async (req, res) => {
  const cached = getCached("popular");
  if (cached) return res.json(cached);
  const q = `query ($p: Int) {
    Page(page: $p, perPage: 50) {
      media(type: ANIME, sort: POPULARITY_DESC, isAdult: false, format_in: [TV, MOVIE, ONA]) { ${MEDIA_FIELDS} }
    }
  }`;
  try {
    const out = [];
    for (let p = 1; p <= 4; p++) {
      const d = await alQuery(q, { p });
      (d?.data?.Page?.media || []).forEach(m => {
        const isSequel = (m.relations?.edges || []).some(e => ["PREQUEL", "PARENT"].includes(e.relationType) && e.node?.type === "ANIME");
        if (!isSequel) out.push(pick(m));
      });
    }
    const list = out.slice(0, 120);
    setCached("popular", list, DAY);
    res.json(list);
  } catch (error) {
    sendError(res, error.response?.status, "Populares", error);
  }
});

app.get("/api/search", searchLimit, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (q.length < 2) return res.json([]);
  const key = "search:" + q.toLowerCase();
  const cached = getCached(key);
  if (cached) return res.json(cached);
  const query = `query ($q: String) {
    Page(page: 1, perPage: 15) {
      media(search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH) { id title { romaji english } format startDate { year } coverImage { large } }
    }
  }`;
  try {
    const d = await alQuery(query, { q });
    const list = (d?.data?.Page?.media || []).map(pick);
    setCached(key, list, 60 * 60 * 1000);
    res.json(list);
  } catch (error) {
    sendError(res, error.response?.status, "Búsqueda", error);
  }
});

// Datos completos (géneros + franquicia) de los animes elegidos por ID de AniList
app.get("/api/media", listLimit, async (req, res) => {
  const ids = [...new Set(String(req.query.ids || "").split(",").map(Number).filter(n => n > 0))].slice(0, 300);
  if (!ids.length) return res.json([]);
  const key = "media:" + [...ids].sort((a, b) => a - b).join(",");
  const cached = getCached(key);
  if (cached) return res.json(cached);
  const q = `query ($ids: [Int]) {
    Page(page: 1, perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } }
  }`;
  try {
    const medias = [];
    for (let i = 0; i < ids.length; i += 50) {
      const d = await alQuery(q, { ids: ids.slice(i, i + 50) });
      medias.push(...(d?.data?.Page?.media || []));
    }
    const items = medias.map(m => ({ ...normalizeAL(m), status: "completed", score: 0 }));
    groupAniList(items, medias);
    setCached(key, items, DAY);
    res.json(items);
  } catch (error) {
    sendError(res, error.response?.status, "AniList", error);
  }
});

// ⚡ Puerto dinámico para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
