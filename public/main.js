document.addEventListener("DOMContentLoaded", () => {

const GENRE_MAP = {
  "Romantic Comedy": "Romance",
  "Psychological": "Suspense",
  "Slice of Life": "Slice of Life",
  "Sci-Fi": "Sci-Fi",
  "Fantasy": "Fantasia",    // agregamos fantasia
  "Shounen": "Shonen"       // agregamos shonen
};

function normalizeGenre(g) { return GENRE_MAP[g] || g; }

const TEAMS = {
  yuyo: { name: "Team Yuyo", likes: ["Romance", "Comedy", "Slice of Life", "Ecchi", "CGCDT", "Mecha", "Music", "Action"] },
  ema:  { name: "Team Ema", likes: ["Mystery", "Sports", "Suspense", "Drama", "Sci-Fi", "Horror", "Mecha", "Music", "Action"] },
  eze:  { name: "Team Eze", likes: ["Isekai", "Adventure", "Action", "Fantasia"] }
};

// Cache global para los detalles
let calculateAffinityCache = {};

// Hacer loadBoth global para el botón
window.loadBoth = async function() {
  const username = document.getElementById("username").value.trim();
  const platform = document.getElementById("platform").value;
  const output = document.getElementById("output");

  if (!username) { output.textContent = "Ingresá un usuario."; return; }

  output.textContent = "Cargando datos...";

  try {
    let animes = [];
    if(platform === "mal") animes = await fetchMAL(username);
    else if(platform === "anilist") animes = await fetchAniList(username);

    const affinity = calculateAffinity(animes); // ya actualiza cache
    showResults(affinity);

  } catch (error) {
    console.error(error);
    output.textContent = "❌ Error al cargar datos. Ver consola.";
  }
}

async function fetchMAL(username) {
  const res = await fetch(`/api/mal/${username}`);
  if (!res.ok) throw new Error("Error consultando backend MAL");
  return await res.json();
}

async function fetchAniList(username) {
  const res = await fetch(`/api/anilist/${username}`);
  if (!res.ok) throw new Error("Error consultando backend AniList");
  return await res.json();
}

// Calcula afinidad, géneros y animes por team
function calculateAffinity(animes){
  const res = {};
  const scores = {};
  const genresByTeam = {};
  const animesByTeamGenre = {};

  Object.keys(TEAMS).forEach(team=>{
    scores[team]=0;
    genresByTeam[team]={};
    animesByTeamGenre[team]={};
  });

  animes.forEach(anime=>{
    anime.genres.forEach(g=>{
      const genre = normalizeGenre(g);
      Object.entries(TEAMS).forEach(([teamKey, team])=>{
        if(team.likes.includes(genre)){
          scores[teamKey]++;
          genresByTeam[teamKey][genre]=(genresByTeam[teamKey][genre]||0)+1;
          if(!animesByTeamGenre[teamKey][genre]) animesByTeamGenre[teamKey][genre]=[];
          animesByTeamGenre[teamKey][genre].push(anime);
        }
      });
    });
  });

  const total = Object.values(scores).reduce((a,b)=>a+b,0);

  Object.keys(TEAMS).forEach(team=>{
    res[team]={ 
      percent: total ? Math.round((scores[team]/total)*100) : 0,
      genresCount: genresByTeam[team],
      animes: animesByTeamGenre[team]
    };
  });

  calculateAffinityCache = res; // guardar cache para usar en botones
  return res;
}

// Mostrar podio interactivo
function showResults(affinity){
  const output=document.getElementById("output");
  output.innerHTML="<h3>Resultado del test</h3><div class='podio'></div>";
  const podioDiv=output.querySelector(".podio");

  const sortedTeams = Object.entries(affinity).sort((a,b)=>b[1].percent - a[1].percent);

  sortedTeams.forEach(([teamKey, data])=>{
    const teamDiv = document.createElement("div");
    teamDiv.className="team";

    teamDiv.innerHTML = `<div class="team-name">${TEAMS[teamKey].name} - ${data.percent}%</div>
                         <div class="bar-container"><div class="bar" id="bar-${teamKey}"></div></div>
                         <button class="btn-detail" onclick="toggleGenres('${teamKey}')">Ver más detalles</button>
                         <div class="genres" id="genres-${teamKey}" style="display:none;"></div>`;

    podioDiv.appendChild(teamDiv);

    setTimeout(()=>{ document.getElementById(`bar-${teamKey}`).style.width=`${data.percent}%`; },100);
  });

  const winner = sortedTeams[0][0];
  podioDiv.innerHTML += `<hr><h4>🏆 Mayor afinidad: ${TEAMS[winner].name}</h4>`;
}

// Toggle géneros
window.toggleGenres = function(teamKey){
  const div = document.getElementById(`genres-${teamKey}`);
  if(div.style.display==="none"){
    div.style.display="block";
    showGenres(teamKey);
  } else {
    div.style.display="none";
    div.innerHTML="";
  }
}

// Mostrar géneros con botones de ver animes
function showGenres(teamKey){
  const div=document.getElementById(`genres-${teamKey}`);
  div.innerHTML="";
  const data = calculateAffinityCache[teamKey];
  if(!data) return;
  Object.entries(data.genresCount).forEach(([genre,count])=>{
    const genreDiv=document.createElement("div");
    genreDiv.innerHTML=`${genre}: ${count} anime(s) <button class="btn-detail" onclick="toggleAnimes('${teamKey}','${genre}')">Ver animes</button>
                        <div class="anime-list" id="animes-${teamKey}-${genre}" style="display:none;"></div>`;
    div.appendChild(genreDiv);
  });
}

// Toggle animes por género
window.toggleAnimes = function(teamKey, genre){
  const div = document.getElementById(`animes-${teamKey}-${genre}`);
  if(div.style.display === "none"){
    div.style.display = "grid";
    div.style.gridTemplateColumns = "repeat(auto-fit, minmax(120px, 1fr))";
    div.style.gap = "10px";

    const animes = calculateAffinityCache[teamKey].animes[genre];
    div.innerHTML = animes.map(a => `
      <div style="text-align:center;">
        <img src="${a.image}" alt="${a.title}" style="width:100px; height:auto; border-radius:5px;">
        <div style="font-size:0.8em; margin-top:5px;">${a.title}</div>
      </div>
    `).join("");
  } else {
    div.style.display = "none";
    div.innerHTML = "";
  }
}

});
