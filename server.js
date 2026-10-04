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

// ---------------- Caché en memoria (10 min) ----------------
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();
function getCached(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.t > CACHE_TTL) { cache.delete(key); return null; }
  return c.data;
}
function setCached(key, data) {
  cache.set(key, { t: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}

// ---------------- Límite por IP (20 consultas/min) ----------------
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (list.length >= 20) return res.status(429).json({ error: "Demasiadas consultas, esperá un minuto." });
  list.push(now);
  hits.set(ip, list);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some(t => now - t < 60000)) hits.delete(ip);
}, 5 * 60000).unref();

// Respuesta de error uniforme
function sendError(res, status, label, error) {
  console.error(`ERROR ${label}:`, error?.response?.data || error?.message || error);
  const code = [403, 404, 429].includes(status) ? status : 502;
  res.status(code).json({ error: label });
}

// ---------------- MAL ----------------
// Una sola request trae lista + géneros + puntaje + estado (antes era 1 request por anime)
app.get("/api/mal/:username", rateLimit, async (req, res) => {
  const username = req.params.username.trim();
  const key = "mal:" + username.toLowerCase();
  const cached = getCached(key);
  if (cached) return res.json(cached);

  try {
    const animes = [];
    let url = `https://api.myanimelist.net/v2/users/${encodeURIComponent(username)}/animelist`;
    let params = { limit: 1000, nsfw: true, fields: "list_status,genres,main_picture" };

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
          status: ls.status === "plan_to_watch" ? "planning" : ls.status || "unknown",
          score: ls.score || 0,
          url: `https://myanimelist.net/anime/${n.id}`
        });
      }
      url = r.data.paging?.next || null;   // la URL "next" ya trae los parámetros
      params = undefined;
    }

    setCached(key, animes);
    res.json(animes);
  } catch (error) {
    sendError(res, error.response?.status, "MAL", error);
  }
});

// ---------------- ANILIST ----------------
const AL_STATUS = { CURRENT: "watching", REPEATING: "watching", COMPLETED: "completed", PAUSED: "on_hold", DROPPED: "dropped", PLANNING: "planning" };
// Etiquetas de AniList que el test usa como "géneros"
const AL_TAGS = ["Isekai", "Cute Girls Doing Cute Things", "Iyashikei"];

app.get("/api/anilist/:username", rateLimit, async (req, res) => {
  const username = req.params.username.trim();
  const key = "al:" + username.toLowerCase();
  const cached = getCached(key);
  if (cached) return res.json(cached);

  const query = `
    query ($username: String) {
      MediaListCollection(userName: $username, type: ANIME) {
        lists {
          entries {
            status
            score(format: POINT_10)
            media { id idMal title { romaji } genres tags { name rank } coverImage { large } }
          }
        }
      }
    }`;

  try {
    const response = await http.post(
      "https://graphql.anilist.co",
      { query, variables: { username } },
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );

    const lists = response.data?.data?.MediaListCollection?.lists || [];
    const seen = new Set();
    const animes = [];
    lists.forEach(list => list.entries.forEach(e => {
      if (!e.media || seen.has(e.media.id)) return;   // un anime puede estar en varias listas personalizadas
      seen.add(e.media.id);
      const tags = (e.media.tags || []).filter(t => AL_TAGS.includes(t.name) && t.rank >= 60).map(t => t.name);
      animes.push({
        id: e.media.id,
        mal_id: e.media.idMal || null,
        title: e.media.title.romaji,
        genres: [...(e.media.genres || []), ...tags],
        image: e.media.coverImage?.large || "",
        status: AL_STATUS[e.status] || "unknown",
        score: e.score || 0,
        url: `https://anilist.co/anime/${e.media.id}`
      });
    }));

    setCached(key, animes);
    res.json(animes);
  } catch (error) {
    const msg = JSON.stringify(error.response?.data?.errors || "");
    const status = /private/i.test(msg) ? 403 : /not found/i.test(msg) ? 404 : error.response?.status;
    sendError(res, status, "AniList", error);
  }
});

// ⚡ Puerto dinámico para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend corriendo en http://localhost:${PORT}`));
