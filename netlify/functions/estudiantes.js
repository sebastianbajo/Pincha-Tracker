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
    opponent: (them.team &&
