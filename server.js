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

// ⚠️ PEGÁ ACÁ TU CLIENT ID DE MAL
const CLIENT_ID = "b35acc338b1fcf0fab6188e73e5cb797";

// ---------------- CACHE ----------------
const malCache = {};      // { username: { data: [...], expires: timestamp } }
const anilistCache = {};  // { username: { data: [...], expires: timestamp } }
const CACHE_TIME = 10 * 60 * 1000; // 10 minutos

// ---------------- MAL ----------------
app.get("/mal/:username", async (req, res) => {
  const username = req.params.username;

  // Revisar cache
  if (malCache[username] && malCache[username].expires > Date.now()) {
    return res.json(malCache[username].data);
  }

  try {
    const listRes = await axios.get(
      `https://api.myanimelist.net/v2/users/${username}/animelist`,
      { headers: { "X-MAL-CLIENT-ID": CLIENT_ID }, params: { limit: 500 } }
    );

    const animePromises = listRes.data.data.map(item =>
      axios.get(`https://api.myanimelist.net/v2/anime/${item.node.id}`, {
        headers: { "X-MAL-CLIENT-ID": CLIENT_ID },
        params: { fields: "title,genres,main_picture" }
      })
    );

    const animeResponses = await Promise.all(animePromises);

    const animes = animeResponses.map(r => ({
      title: r.data.title,
      genres: r.data.genres?.map(g => g.name) || [],
      image: r.data.main_picture?.medium || ""
    }));

    // Guardar en cache
    malCache[username] = { data: animes, expires: Date.now() + CACHE_TIME };

    res.json(animes);

  } catch (error) {
    if (error.response?.status === 429) {
      console.error("Se alcanzó el límite de requests a MAL");
      return res.status(429).json({ error: "Demasiadas solicitudes a MAL. Intentá más tarde." });
    }
    console.error("ERROR REAL DE MAL:", error.response?.data || error.message);
    res.status(500).json({ error: "No se pudieron cargar datos de MAL." });
  }
});

// ---------------- ANILIST ----------------
app.get("/anilist/:username", async (req, res) => {
  const username = req.params.username;

  // Revisar cache
  if (anilistCache[username] && anilistCache[username].expires > Date.now()) {
    return res.json(anilistCache[username].data);
  }

  try {
    const query = `
      query ($username: String) {
        MediaListCollection(userName: $username, type: ANIME) {
          lists {
            entries {
              media {
                title { romaji }
                genres
                coverImage { large }
              }
              status
            }
          }
        }
      }
    `;

    const response = await axios.post(
      "https://graphql.anilist.co",
      { query, variables: { username } },
      { headers: { "Content-Type": "application/json" } }
    );

    if (!response.data.data || !response.data.data.MediaListCollection) {
      console.warn("Usuario no encontrado en AniList:", username);
      return res.json([]);
    }

    const animes = [];
    response.data.data.MediaListCollection.lists.forEach(list => {
      list.entries
        .filter(entry => entry.status && ["CURRENT", "COMPLETED"].includes(entry.status))
        .forEach(entry => {
          animes.push({
            title: entry.media.title.romaji,
            genres: entry.media.genres || [],
            image: entry.media.coverImage?.large || ""
          });
        });
    });

    // Guardar en cache
    anilistCache[username] = { data: animes, expires: Date.now() + CACHE_TIME };

    res.json(animes);

  } catch (error) {
    console.error("ERROR REAL DE AniList:", error.response?.data || error.message);
    res.status(500).json({ error: "No se pudieron cargar datos de AniList." });
  }
});

// ⚡ Puerto dinámico para Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
});
