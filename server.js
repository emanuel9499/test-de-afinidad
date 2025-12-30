

import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());

// ⚠️ PEGÁ ACÁ TU CLIENT ID DE MAL
const CLIENT_ID = "b35acc338b1fcf0fab6188e73e5cb797";

// ---------------- MAL ----------------
app.get("/mal/:username", async (req, res) => {
  try {
    const username = req.params.username;

    // Traer todos los animes del usuario (sin filtrar)
    const listRes = await axios.get(
      `https://api.myanimelist.net/v2/users/${username}/animelist`,
      {
        headers: { "X-MAL-CLIENT-ID": CLIENT_ID },
        params: { limit: 500 }
      }
    );

    // Extraer título, géneros e imagen
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

    res.json(animes);

  } catch (error) {
    console.error("ERROR REAL DE MAL:");
    console.error(error.response?.data || error.message);
    res.status(500).json(error.response?.data || { error: "Error desconocido" });
  }
});

// ---------------- ANILIST ----------------
app.get("/anilist/:username", async (req, res) => {
  try {
    const username = req.params.username;

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

    // Filtrar solo animes CURRENT (viendo) o COMPLETED (completados)
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

    res.json(animes);

  } catch (error) {
    console.error("ERROR REAL DE AniList:");
    console.error(error.response?.data || error.message);
    res.status(500).json(error.response?.data || { error: "Error desconocido" });
  }
});

app.listen(3000, () => {
  console.log("Backend corriendo en http://localhost:3000");
});
