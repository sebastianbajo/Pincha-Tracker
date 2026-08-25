// Netlify Function: fetches live data about Club Estudiantes de La Plata
// from ESPN's public (unofficial) JSON API, across three competitions,
// and returns one clean payload for the frontend to render.
//
// This runs server-side on Netlify, so there is no browser CORS problem —
// the function talks to ESPN, and the page talks to the function (same origin).

const TEAM_ID = "8"; // Estudiantes de La Plata, ESPN team id

const LEAGUES = [
  { key: "liga", name: "Liga Profesional", slug: "arg.1", hasTable: true },
  { key: "argentina", name: "Copa Argentina", slug: "arg.copa", hasTable: false },
  { key: "libertadores", name: "Copa Libertadores", slug: "conmebol.libertadores", hasTable: false },
];

const STANDINGS_LEAGUE_SLUG = "arg.1";

function scheduleUrl(slug) {
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${TEAM_ID}/schedule`;
}
function standingsUrl(slug) {
  return `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
}

const https = require("https");

// Plain Node `https` request instead of global fetch: some Netlify Function
// runtimes don't expose fetch, so this avoids depending on it entirely.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/json,text/plain,*/*",
        },
        timeout: 8000,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`Bad JSON from ${url}: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout fetching ${url}`)));
    req.on("error", reject);
  });
}

// Find a stat value inside ESPN's stats[] array by trying several possible
// name/abbreviation aliases (ESPN's exact keys vary a bit by sport/endpoint).
function getStat(entry, aliases) {
  const stats = entry && entry.stats;
  if (!Array.isArray(stats)) return null;
  const wanted = aliases.map((a) => a.toLowerCase());
  for (const s of stats) {
    const candidates = [s.name, s.abbreviation, s.shortDisplayName, s.displayName]
      .filter(Boolean)
      .map((x) => String(x).toLowerCase());
    if (candidates.some((c) => wanted.includes(c))) {
      const v = s.value != null ? s.value : s.displayValue;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
  }
  return null;
}

function isEstudiantesHome(competition) {
  const home = (competition.competitors || []).find((c) => c.homeAway === "home");
  return !!(home && String(home.team && home.team.id) === TEAM_ID);
}

function parseEvent(event, leagueMeta) {
  const competition = event.competitions && event.competitions[0];
  if (!competition) return null;
  const competitors = competition.competitors || [];
  const us = competitors.find((c) => String(c.team && c.team.id) === TEAM_ID);
  const them = competitors.find((c) => String(c.team && c.team.id) !== TEAM_ID);
  if (!us || !them) return null;

  const completed = !!(competition.status && competition.status.type && competition.status.type.completed);
  const dateISO = event.date;
  const isHome = competition.competitors.find((c) => c.homeAway === "home") === us;

  let roundLabel = null;
  const note = competition.notes && competition.notes[0] && competition.notes[0].headline;
  if (note) roundLabel = note;

  return {
    id: event.id,
    league: leagueMeta.key,
    leagueName: leagueMeta.name,
    dateISO,
    completed,
    isHome,
    opponent: (them.team && (them.team.displayName || them.team.name)) || "Rival",
    venue: (competition.venue && competition.venue.fullName) || null,
    roundLabel,
    scoreFor: us.score != null ? Number(us.score.value != null ? us.score.value : us.score) : null,
    scoreAgainst: them.score != null ? Number(them.score.value != null ? them.score.value : them.score) : null,
  };
}

async function loadLeague(leagueMeta) {
  const data = await fetchJson(scheduleUrl(leagueMeta.slug));
  const events = Array.isArray(data.events) ? data.events : [];
  const parsed = events.map((e) => parseEvent(e, leagueMeta)).filter(Boolean);
  parsed.sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
  const completed = parsed.filter((e) => e.completed);
  const upcoming = parsed.filter((e) => !e.completed);
  return { completed, upcoming };
}

async function loadStandings() {
  const data = await fetchJson(standingsUrl(STANDINGS_LEAGUE_SLUG));
  const groups = Array.isArray(data.children) ? data.children : [];
  // Find the group (zone) that contains Estudiantes de La Plata.
  for (const group of groups) {
    const entries = (group.standings && group.standings.entries) || [];
    const idx = entries.findIndex((e) => String(e.team && e.team.id) === TEAM_ID);
    if (idx !== -1) {
      const mapped = entries.map((e, i) => ({
        rank: getStat(e, ["rank"]) ?? i + 1,
        team: (e.team && (e.team.shortDisplayName || e.team.displayName || e.team.name)) || "Equipo",
        points: getStat(e, ["points", "pts"]),
        played: getStat(e, ["gamesplayed", "gp"]),
        won: getStat(e, ["wins", "w"]),
        drawn: getStat(e, ["ties", "draws", "d"]),
        lost: getStat(e, ["losses", "l"]),
        goalsFor: getStat(e, ["pointsfor", "goalsfor", "gf", "f"]),
        goalsAgainst: getStat(e, ["pointsagainst", "goalsagainst", "ga", "a"]),
        isUs: String(e.team && e.team.id) === TEAM_ID,
      }));
      mapped.sort((a, b) => (a.rank || 0) - (b.rank || 0));
      return { group: group.name || "Zona", entries: mapped };
    }
  }
  return null;
}

exports.handler = async function handler() {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=300", // 5 minutes edge cache
    "Access-Control-Allow-Origin": "*",
  };

  const results = await Promise.allSettled([
    loadLeague(LEAGUES[0]),
    loadLeague(LEAGUES[1]),
    loadLeague(LEAGUES[2]),
    loadStandings(),
  ]);

  const [ligaR, argR, libR, standingsR] = results;

  const byLeague = {
    liga: ligaR.status === "fulfilled" ? ligaR.value : { completed: [], upcoming: [] },
    argentina: argR.status === "fulfilled" ? argR.value : { completed: [], upcoming: [] },
    libertadores: libR.status === "fulfilled" ? libR.value : { completed: [], upcoming: [] },
  };
  const standings = standingsR.status === "fulfilled" ? standingsR.value : null;

  // Next match: earliest upcoming event across all three competitions.
  const allUpcoming = []
    .concat(byLeague.liga.upcoming, byLeague.argentina.upcoming, byLeague.libertadores.upcoming)
    .sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
  const nextMatch = allUpcoming[0] || null;

  // Recent results: last 5 completed events across all competitions, most recent first.
  const allCompleted = []
    .concat(byLeague.liga.completed, byLeague.argentina.completed, byLeague.libertadores.completed)
    .sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));
  const recentResults = allCompleted.slice(0, 6);

  const ligaRank = standings ? standings.entries.find((e) => e.isUs) : null;

  const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null);

  const competitions = [
    {
      key: "liga",
      name: "Liga Profesional",
      phase: ligaRank ? `Clausura · ${standings.group} · ${ligaRank.rank}°` : "Clausura",
      hasTable: true,
      ok: ligaR.status === "fulfilled",
      nextEvent: byLeague.liga.upcoming[0] || null,
      lastResult: lastOf(byLeague.liga.completed),
    },
    {
      key: "argentina",
      name: "Copa Argentina",
      phase:
        (byLeague.argentina.upcoming[0] && byLeague.argentina.upcoming[0].roundLabel) ||
        (byLeague.argentina.completed.length || byLeague.argentina.upcoming.length
          ? "En curso"
          : "Sin datos"),
      hasTable: false,
      ok: argR.status === "fulfilled",
      nextEvent: byLeague.argentina.upcoming[0] || null,
      lastResult: lastOf(byLeague.argentina.completed),
    },
    {
      key: "libertadores",
      name: "Copa Libertadores",
      phase:
        (byLeague.libertadores.upcoming[0] && byLeague.libertadores.upcoming[0].roundLabel) ||
        (byLeague.libertadores.completed.length || byLeague.libertadores.upcoming.length
          ? "En curso"
          : "Sin datos"),
      hasTable: false,
      ok: libR.status === "fulfilled",
      nextEvent: byLeague.libertadores.upcoming[0] || null,
      lastResult: lastOf(byLeague.libertadores.completed),
    },
  ];

  const body = {
    updatedAt: new Date().toISOString(),
    nextMatch,
    competitions,
    recentResults,
    standings,
    // surface partial-failure info (including the reason, for debugging) so
    // the frontend can show a soft warning and we can diagnose issues live.
    sourceStatus: {
      liga: ligaR.status === "fulfilled" ? "fulfilled" : String(ligaR.reason && ligaR.reason.message),
      argentina: argR.status === "fulfilled" ? "fulfilled" : String(argR.reason && argR.reason.message),
      libertadores: libR.status === "fulfilled" ? "fulfilled" : String(libR.reason && libR.reason.message),
      standings: standingsR.status === "fulfilled" ? "fulfilled" : String(standingsR.reason && standingsR.reason.message),
    },
  };

  return { statusCode: 200, headers, body: JSON.stringify(body) };
};
