/*
 * Cartes Voitures : voitures électriques, hybrides rechargeables et thermiques, et leurs batteries 12 V,
 * en cartes Lovelace autonomes dans un seul fichier.
 *
 *   custom:voiture-electrique-card   voiture électrique ou hybride rechargeable : batterie, autonomie, charge, climatisation
 *   custom:voiture-thermique-card    voitures suivies par Torque Pro (Torque OBD-II) : en route, dernier trajet, voyant moteur
 *   custom:voiture-batteries-card    batteries 12 V suivies par des boîtiers BM6 : tension, charge, courbe, trajets
 *
 * Anciennement dans les Cartes Maison HA (maison-voiture-card, maison-torque-card, maison-batteries-card) :
 * ces anciens noms restent reconnus, les tableaux de bord existants continuent de fonctionner.
 */

(() => {
const CARD_VERSION = "0.2.0-beta.2";

/* ------------------------------------------------------------- utilitaires */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const BAD = new Set(["unknown", "unavailable", "none", "None", ""]);

/** Nombre lu dans un état, ou null. « 1:05:00 » donne des minutes. */
const num = (v) => {
  if (v === null || v === undefined || typeof v === "boolean") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (BAD.has(s)) return null;
  const hms = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (hms) return Number(hms[1]) * 60 + Number(hms[2]) + Number(hms[3] || 0) / 60;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const fmt = (n, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Minutes en « 1 h 05 » ou « 25 min ». */
const hm = (min) => {
  if (min === null) return "—";
  const m = Math.max(0, Math.round(min));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
};

/** Minutes en « 01:05:00 ». */
const hms = (min) => {
  if (min === null) return "—";
  const s = Math.max(0, Math.round(min * 60));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, "0")).join(":");
};

const relTime = (iso) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const s = (t - Date.now()) / 1000;
  const a = Math.abs(s);
  const txt = a < 90 ? "moins d'une minute" : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} j`;
  return s >= 0 ? `dans ${txt}` : `il y a ${txt}`;
};

/** États traduits en français, par domaine puis généraux. */
const STATE_FR = {
  cover: { open: "Ouvert", closed: "Fermé", opening: "Ouverture…", closing: "Fermeture…", stopped: "Arrêté" },
  alarm_control_panel: {
    disarmed: "désarmée", armed_away: "mode absent", armed_home: "mode présence", armed_night: "mode nuit",
    armed_vacation: "mode vacances", armed_custom_bypass: "mode personnalisé", arming: "armement…",
    pending: "en attente…", triggered: "déclenchée !", disarming: "désarmement…",
  },
  vacuum: { cleaning: "Nettoyage", docked: "Sur la base", returning: "Retour à la base", idle: "Inactif", paused: "En pause", error: "Erreur" },
  lock: { locked: "Verrouillé", unlocked: "Déverrouillé", locking: "Verrouillage…", unlocking: "Déverrouillage…", jammed: "Bloqué", open: "Ouvert" },
  media_player: { playing: "Lecture", paused: "Pause", idle: "Inactif", off: "Éteint", on: "Allumé", standby: "Veille", buffering: "Chargement" },
  "": { on: "On", off: "Off", home: "Présent", not_home: "Absent", unavailable: "Indisponible", unknown: "Inconnu", open: "Ouvert", closed: "Fermé" },
};
const stateFr = (s, domain = "") => {
  if (s === null || s === undefined) return "—";
  const k = String(s);
  return STATE_FR[domain]?.[k] ?? STATE_FR[""][k] ?? k;
};

const domainOf = (id) => String(id || "").split(".")[0];
const friendly = (o) => o?.attributes?.friendly_name || o?.entity_id || "";

/* ------------------------------------------------- modèles de texte {…} */

/**
 * Remplace les {…} d'un texte :
 *   {state} {unit} {name} {attr:nom}            l'entité de l'élément
 *   {sensor.x} {sensor.x:attribut}             une autre entité
 * suivis de filtres séparés par | :
 *   0 1 2 (décimales), k (÷ 1000), hm (minutes → 1 h 05), hms (→ 01:05:00),
 *   date, time, rel (il y a…), fr (état traduit), upper, lower, int
 */
const TPL_RE = /\{([a-z_]+\.[a-z0-9_]+(?::[a-z0-9_]+)?|state|unit|name|attr:[a-zA-Z0-9_]+)((?:\|[a-z0-9_]+)*)\}/g;

function applyFilters(v, filters, domain) {
  let out = v;
  for (const f of filters) {
    if (f === "k") out = num(out) === null ? out : num(out) / 1000;
    else if (/^\d$/.test(f)) out = num(out) === null ? out : fmt(num(out), Number(f));
    else if (f === "int") out = num(out) === null ? out : Math.round(num(out));
    else if (f === "hm") out = hm(num(out));
    else if (f === "hms") out = hms(num(out));
    else if (f === "date") out = Number.isFinite(new Date(out).getTime()) ? new Date(out).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : out;
    else if (f === "time") out = Number.isFinite(new Date(out).getTime()) ? new Date(out).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : out;
    else if (f === "rel") out = relTime(out) ?? out;
    else if (f === "fr") out = stateFr(out, domain);
    else if (f === "upper") out = String(out ?? "").toUpperCase();
    else if (f === "lower") out = String(out ?? "").toLowerCase();
  }
  if (out === null || out === undefined || BAD.has(String(out))) return "—";
  if (typeof out === "number") return Number.isInteger(out) ? String(out) : fmt(out, 1);
  return String(out);
}

/** Texte brut, {…} remplacés. */
function tplText(str, hass, eid) {
  if (str === null || str === undefined) return "";
  return String(str).replace(TPL_RE, (m, key, filt) => {
    const filters = filt ? filt.slice(1).split("|") : [];
    const so = eid ? hass?.states?.[eid] : null;
    if (key === "unit") return so?.attributes?.unit_of_measurement || "";
    if (key === "name") return friendly(so);
    if (key === "state") return applyFilters(so?.state, filters, domainOf(eid));
    if (key.startsWith("attr:")) return applyFilters(so?.attributes?.[key.slice(5)], filters, domainOf(eid));
    const [id, at] = key.split(":");
    const o = hass?.states?.[id];
    if (!o) return "—";
    return applyFilters(at ? o.attributes?.[at] : o.state, filters, domainOf(id));
  });
}

/** Texte prêt pour le HTML : échappé, retours à la ligne conservés. */
const tpl = (str, hass, eid) => esc(tplText(str, hass, eid)).replace(/\n/g, "<br>");

/** Texte choisi selon des conditions : une chaîne, ou une liste de { if, text }. */
function pickText(spec, hass, eid) {
  if (spec === null || spec === undefined) return null;
  if (!Array.isArray(spec)) return tpl(spec, hass, eid);
  for (const it of spec) {
    if (typeof it === "string") return tpl(it, hass, eid);
    if (cond(it.if, hass, eid)) return tpl(it.text, hass, eid);
  }
  return null;
}

/* --------------------------------------------------------------- conditions */

const hhmm = (s) => { const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(s)); return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null; };

/**
 * Condition d'affichage ou de couleur :
 *   { state: on }  { state: [a, b] }  { state_not: off }  { above: 0 }  { below: 30 }
 *   { entity: autre.entite, … }  { attribute: nom, … }  { after: "16:00" }  { before: "8:00" }
 *   { weekday: [mon, tue] }  { or: [ … ] }  { and: [ … ] }  { not: { … } }
 * Une liste vaut un « et ». Sans entité précisée, c'est celle de l'élément.
 */
function cond(c, hass, eid) {
  if (c === null || c === undefined) return true;
  if (Array.isArray(c)) return c.every((x) => cond(x, hass, eid));
  if (typeof c !== "object") return String(hass?.states?.[eid]?.state) === String(c);
  if (c.or) return [].concat(c.or).some((x) => cond(x, hass, eid));
  if (c.and && !cond(c.and, hass, eid)) return false;
  if (c.not && cond(c.not, hass, eid)) return false;
  const id = c.entity || eid;
  const o = id ? hass?.states?.[id] : null;
  const s = c.attribute ? o?.attributes?.[c.attribute] : o?.state;
  if ("state" in c && ![].concat(c.state).map(String).includes(String(s))) return false;
  if ("state_not" in c && [].concat(c.state_not).map(String).includes(String(s))) return false;
  if ("above" in c && !(num(s) !== null && num(s) > Number(c.above))) return false;
  if ("below" in c && !(num(s) !== null && num(s) < Number(c.below))) return false;
  if ("after" in c || "before" in c) {
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    if ("after" in c && !(now >= hhmm(c.after))) return false;
    if ("before" in c && !(now < hhmm(c.before))) return false;
  }
  if (c.weekday) {
    const wd = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
    if (![].concat(c.weekday).includes(wd)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ couleurs */

const COLORS = {
  green: "var(--m-green)", vert: "var(--m-green)",
  orange: "var(--m-orange)",
  red: "var(--m-red)", rouge: "var(--m-red)",
  yellow: "var(--m-yellow)", jaune: "var(--m-yellow)",
  blue: "var(--m-blue)", bleu: "var(--m-blue)",
  "blue-dark": "var(--m-blue-dark)", "bleu-fonce": "var(--m-blue-dark)",
  purple: "var(--m-purple)", violet: "var(--m-purple)",
  brown: "var(--m-brown)", marron: "var(--m-brown)",
  pop: "var(--m-pop)", accent: "var(--m-pop)",
  grey: "var(--m-chip)", gray: "var(--m-chip)", gris: "var(--m-chip)",
  white: "var(--m-card)", blanc: "var(--m-card)",
  black: "var(--m-text)", noir: "var(--m-text)",
  none: "transparent",
};
/** Couleur nommée, ou valeur CSS simple (#hex, rgb(), var()). */
const color = (c) => {
  if (c === null || c === undefined || c === "") return null;
  const k = String(c).trim();
  if (COLORS[k]) return COLORS[k];
  return /^[#\w(),.%\s-]+$/.test(k) ? k : null;
};
/** Première couleur dont la condition est vraie : [{ above: 60, color: green }, { color: red }]. */
const levelColor = (levels, hass, eid) => {
  for (const l of [].concat(levels || [])) if (cond(l, hass, eid)) return color(l.color);
  return null;
};
/** Couleur de texte lisible sur une couleur de fond « pastel » ou foncée. */
const onColor = (c) => (/blue-dark|bleu-fonce|m-text|m-blue-dark/.test(String(c)) ? "var(--m-card)" : "var(--m-on-pop)");

/* ------------------------------------------------------- pièces et étages */

const regOf = (hass, eid) => hass?.entities?.[eid];
const areaOf = (hass, eid) => {
  const e = regOf(hass, eid);
  if (!e) return null;
  return e.area_id || hass.devices?.[e.device_id]?.area_id || null;
};
/** Entité « visible » : ni masquée, ni de configuration / diagnostic. */
const shown = (hass, eid) => {
  const e = regOf(hass, eid);
  return !e || (!e.hidden && !e.hidden_by && !e.entity_category);
};
const floorsOf = (hass) => Object.values(hass?.floors || {}).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
const areasOf = (hass) => Object.values(hass?.areas || {});
/** Icône d'étage selon le niveau. */
const floorIcon = (f) => f?.icon || (f?.level < 0 ? "mdi:home-floor-negative-1" : f?.level > 0 ? `mdi:home-floor-${Math.min(3, f.level)}` : "mdi:home-floor-0");

const entitiesIn = (hass, areaId, domain, test) =>
  Object.keys(hass?.states || {}).filter((id) => domainOf(id) === domain && areaOf(hass, id) === areaId && shown(hass, id) && (!test || test(hass.states[id])));

/* ----------------------------------------------------- historique partagé */

const BUS = new EventTarget();
const HIST = new Map(); // entity_id → { at, pts, busy }

/** Points [t, v] des dernières `hours` heures. Chargés une fois pour toutes les cartes, renouvelés toutes les 10 min. */
function historyOf(hass, id, hours = 24) {
  if (!id || !hass?.callApi) return null;
  const key = `${id}|${hours}`;
  const c = HIST.get(key);
  if (c && (c.busy || Date.now() - c.at < 10 * 60e3)) return c.pts;
  HIST.set(key, { at: Date.now(), pts: c?.pts || null, busy: true });
  const end = Date.now();
  const start = end - hours * 3600e3;
  const path = `history/period/${encodeURIComponent(new Date(start).toISOString())}?filter_entity_id=${encodeURIComponent(id)}` +
    `&end_time=${encodeURIComponent(new Date(end).toISOString())}&minimal_response&no_attributes`;
  hass.callApi("GET", path).then((rows) => {
    const pts = (Array.isArray(rows?.[0]) ? rows[0] : [])
      .map((r) => [new Date(r.last_changed || r.last_updated).getTime(), num(r.state)])
      .filter((p) => Number.isFinite(p[0]) && p[1] !== null);
    HIST.set(key, { at: Date.now(), pts, busy: false });
  }).catch(() => {
    HIST.set(key, { at: Date.now(), pts: c?.pts || [], busy: false });
  }).finally(() => BUS.dispatchEvent(new CustomEvent("hist", { detail: id })));
  return c?.pts || null;
}

/** Courbe SVG (ligne et aire) des points, dans une boîte w × h. */
function spark(pts, w = 300, h = 60, hours = 24, span = 1) {
  if (!pts || pts.length < 2) return "";
  const end = Date.now();
  const start = end - hours * 3600e3;
  const vs = pts.map((p) => p[1]);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < span) { lo -= span / 2; hi += span / 2; }
  const x = (t) => ((Math.max(t, start) - start) / (end - start)) * w;
  const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
  let d = "";
  pts.forEach((p, i) => { d += `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)} `; });
  d += `L${w},${y(pts[pts.length - 1][1]).toFixed(1)}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="spark-a" d="${d} L${w},${h} L0,${h} Z"/><path class="spark-l" d="${d}"/></svg>`;
}

/* ---------------------------------------------------------------- actions */

const fire = (node, type, detail) =>
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

function navigate(path) {
  if (!path) return;
  const url = path.startsWith("#") ? `${location.pathname}${location.search}${path}` : path;
  history.pushState(null, "", url);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
}

/* ------------------------------------------------------------------ thèmes */

/** maison : fond, texte et pastilles suivent le thème Home Assistant de l'utilisateur (--card-background-color,
 *  --primary-text-color…), avec les touches de couleur pastel ; --gray000 / --gray800 / --active-pop… restent prioritaires ;
 *  v2 : style MyElectricalData bleu nuit ; auto : MyElectricalData clair ou sombre ; ha : couleurs du thème Home Assistant. */
const themeClass = (theme, hass) => {
  const dark = hass?.themes?.darkMode === true;
  if (theme === "v2") return "th-v2";
  if (theme === "auto") return dark ? "th-v2" : "th-v2 light";
  if (theme === "ha") return "th-ha";
  if (theme === "obd") return "th-obd";
  return dark ? "th-maison dark" : "th-maison";
};

const BASE_STYLE = `<style>
:host { display: block; font-family: var(--ha-font-family-body, inherit); font-synthesis-weight: var(--maison-font-synthesis, auto); }
ha-card {
  --m-radius: 22px;
  background: var(--m-card); color: var(--m-text); border: none; box-shadow: var(--maison-shadow, none);
  border-radius: var(--m-radius); overflow: hidden; position: relative; height: 100%; box-sizing: border-box;
  font-variant-numeric: tabular-nums; container-type: inline-size; -webkit-tap-highlight-color: transparent;
}
ha-card.th-maison {
  --m-card: var(--gray000, var(--ha-card-background, var(--card-background-color, #f4f3f1)));
  --m-text: var(--gray800, var(--primary-text-color, #2b2c2f));
  --m-chip: var(--gray200, color-mix(in srgb, var(--m-text) 9%, var(--m-card)));
  --m-faint: var(--gray400, var(--disabled-text-color, #b4b2ad)); --m-pop: var(--active-pop, #f6b38b); --m-on-pop: var(--active-on-pop, var(--gray800, #2b2c2f));
  --m-green: var(--active-green, #94d3a2); --m-orange: var(--active-orange, #f5c27a); --m-red: var(--active-red, #f08c84);
  --m-yellow: var(--active-yellow, #f3dc76); --m-blue: var(--active-blue, #8eb5f5); --m-blue-dark: var(--active-blue-dark, #3f5d8f);
  --m-purple: var(--active-purple, #c4a8f4); --m-brown: var(--active-brown, #b98a63); --m-acc: var(--pop, #d2703a);
}
ha-card.th-maison.dark {
  --m-card: var(--gray000, var(--ha-card-background, var(--card-background-color, #24272c)));
  --m-text: var(--gray800, var(--primary-text-color, #eceef1));
  --m-chip: var(--gray200, color-mix(in srgb, var(--m-text) 12%, var(--m-card)));
  --m-faint: var(--gray400, var(--disabled-text-color, #6d737c)); --m-pop: var(--active-pop, #f0a274); --m-on-pop: var(--active-on-pop, #1f2124);
  --m-green: var(--active-green, #6fbf83); --m-orange: var(--active-orange, #e9ad5b); --m-red: var(--active-red, #e5776e);
  --m-yellow: var(--active-yellow, #e2c95a); --m-blue: var(--active-blue, #6f9de8); --m-blue-dark: var(--active-blue-dark, #4a6fae);
  --m-purple: var(--active-purple, #a98be6); --m-brown: var(--active-brown, #a77a55); --m-acc: var(--pop, #f0a274);
}
ha-card.th-v2 {
  --m-card: #1a2434; --m-chip: #212d40; --m-text: #e7edf5; --m-faint: #5d6e88; --m-pop: #1d93e3; --m-on-pop: #ffffff;
  --m-green: #5fcf8a; --m-orange: #f0a33a; --m-red: #ee4a4a; --m-yellow: #f7c948; --m-blue: #1d93e3; --m-blue-dark: #2b56a8;
  --m-purple: #8c6be0; --m-brown: #a77a55; --m-acc: #1d93e3; --m-lime: #96d21f;
  border: 1px solid #2f3d55; --m-radius: 18px;
}
ha-card.th-v2.light {
  --m-card: #ffffff; --m-chip: #eef2f7; --m-text: #1a2434; --m-faint: #a3afc0; --m-pop: #1673b8; --m-on-pop: #ffffff;
  --m-green: #1d8a4b; --m-orange: #b0640a; --m-red: #c62f2f; --m-yellow: #8a6500; --m-blue: #1673b8; --m-blue-dark: #24508f; --m-acc: #1673b8; --m-lime: #4c8a0b;
  border-color: #dbe2ec; box-shadow: 0 1px 3px rgba(26, 36, 52, .08);
}
ha-card.th-ha {
  --m-card: var(--ha-card-background, var(--card-background-color, #fff));
  --m-chip: color-mix(in srgb, var(--primary-text-color, #000) 8%, transparent);
  --m-text: var(--primary-text-color, #1f2937); --m-faint: var(--disabled-text-color, #9aa0a6);
  --m-pop: var(--accent-color, #ff9800); --m-on-pop: var(--text-accent-color, #fff);
  --m-green: var(--success-color, #43a047); --m-orange: var(--warning-color, #ffa600); --m-red: var(--error-color, #db4437);
  --m-yellow: var(--state-sensor-battery-medium-color, #f3c623); --m-blue: var(--info-color, #039be5);
  --m-blue-dark: var(--primary-color, #03a9f4); --m-purple: #9c6ade; --m-brown: #a77a55; --m-acc: var(--accent-color, #ff9800);
  --m-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
}
/* obd : tableau de bord d'application OBD, cadrans noirs à lunette chromée, arc rouge, chiffres bleu cyan */
ha-card.th-obd {
  --m-card: #050608; --m-chip: #0b0e12; --m-text: #cfe8ff; --m-faint: #3b4a5c; --m-pop: #35b5ff; --m-on-pop: #02121f;
  --m-green: #27d36c; --m-orange: #ff9a1f; --m-red: #ff2414; --m-yellow: #ffd23a; --m-blue: #35b5ff; --m-blue-dark: #1b6fb0;
  --m-purple: #8c6be0; --m-brown: #a77a55; --m-acc: #35b5ff; --m-lime: #35b5ff; --m-lcd: #4cc3ff;
  border: 1px solid #1a2028; --m-radius: 16px;
  background: radial-gradient(120% 90% at 50% 0%, #11161c 0%, #050608 60%);
}
ha-card { --m-muted: color-mix(in srgb, var(--m-text) 62%, transparent); --m-line: color-mix(in srgb, var(--m-text) 12%, transparent); }
ha-icon { --mdc-icon-size: 24px; display: inline-flex; }
[data-a], [data-h] { cursor: pointer; }
[data-a]:focus-visible, [data-h]:focus-visible, button:focus-visible { outline: 2px solid var(--m-pop); outline-offset: 2px; }
button { font: inherit; color: inherit; }
.ls { letter-spacing: .3em; }
.muted { color: var(--m-muted); }
/* barre de boutons ronds dans une pilule */
.rbar { display: flex; gap: 4px; padding: 5px; border-radius: 50px; background: var(--m-chip); }
.rbar.col { flex-direction: column; }
.rb { all: unset; box-sizing: border-box; width: 44px; height: 44px; flex: 1 1 44px; max-width: 64px; min-width: 38px; border-radius: 50px; display: grid; place-items: center;
  cursor: pointer; color: var(--m-text); transition: background .2s; }
.rbar.col .rb { flex: none; width: 44px; }
.rb ha-icon { --mdc-icon-size: 24px; }
.rb.on { background: var(--m-pop); color: var(--m-on-pop); }
.rb.warn { background: var(--m-red); color: var(--m-on-pop); }
.rb:focus-visible { outline: 2px solid var(--m-pop); outline-offset: 1px; }
.spark { width: 100%; height: 100%; display: block; }
.spark-l { fill: none; stroke: var(--m-pop); stroke-width: 2; vector-effect: non-scaling-stroke; }
.spark-a { fill: var(--m-pop); opacity: .12; stroke: none; }
.bar-p { height: 8px; border-radius: 8px; background: var(--m-line); overflow: hidden; }
.bar-p i { display: block; height: 100%; border-radius: 8px; background: var(--m-pop); }
.empty { padding: 16px; font-size: .9rem; color: var(--m-muted); }
.empty b { color: var(--m-text); display: block; margin-bottom: 4px; }
@keyframes m-flash { 0%, 100% { opacity: .85; } 50% { opacity: .15; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>`;

/* -------------------------------------------------------------- carte de base */

class MaisonCard extends HTMLElement {
  static get DEFAULTS() { return { theme: "maison" }; }

  setConfig(config) {
    if (!config || typeof config !== "object") throw new Error("Configuration invalide");
    this._config = { ...this.constructor.DEFAULTS, ...config };
    this._check?.(this._config);
    this._ui = this._ui || {};
    this._sig = null;
    this._res = null;
    if (!this.shadowRoot) this._setup();
    if (this._hass) this._update(true);
  }

  set hass(h) {
    const first = !this._hass;
    this._hass = h;
    if (first || this._regKey !== this._registryKey()) this._res = null;
    this._update(false);
  }

  get hass() { return this._hass; }

  set editMode(v) { this._editMode = v; this._update(true); }

  get editMode() { return this._editMode; }

  set preview(v) { this._preview = v; this._update(true); }

  get preview() { return this._preview; }

  connectedCallback() {
    if (!this._onHist) {
      this._onHist = (ev) => { if (this._histIds?.includes(ev.detail)) this._update(true); };
    }
    BUS.addEventListener("hist", this._onHist);
    this._timer = setInterval(() => this._tick?.(), 60e3);
    if (this._hass && this._config) this._update(true);
  }

  disconnectedCallback() {
    BUS.removeEventListener("hist", this._onHist);
    clearInterval(this._timer);
  }

  getCardSize() { return 3; }

  /** Clé du registre : la détection automatique est refaite quand les entités ou pièces changent. */
  _registryKey() {
    const h = this._hass;
    return `${Object.keys(h?.states || {}).length}|${Object.keys(h?.entities || {}).length}|${Object.keys(h?.areas || {}).length}`;
  }

  /** Résultat de la détection automatique, gardé en cache. */
  _resolved() {
    if (!this._res) {
      this._regKey = this._registryKey();
      this._res = this._resolve ? this._resolve(this._config, this._hass) : {};
    }
    return this._res;
  }

  /** Entités dont un changement redessine la carte. */
  _ids() { return []; }

  _update(force) {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    if (this._busy && !force) return;
    let sig = `${this._hass.themes?.darkMode ? "d" : "l"}|${JSON.stringify(this._ui)}`;
    for (const id of this._ids()) {
      const o = this._hass.states[id];
      sig += `|${id}=${o ? `${o.state}@${o.last_updated || o.last_changed || ""}` : "-"}`;
    }
    if (!force && sig === this._sig) return;
    this._sig = sig;
    this._draw();
  }

  _tick() { this._update(true); }

  _draw() {
    this._acts = [];
    this._histIds = [];
    let body;
    try {
      body = this._render(this._config, this._hass);
    } catch (err) {
      console.error(`[${this.localName}]`, err);
      body = `<div class="empty"><b>Erreur d'affichage</b>${esc(err?.message || err)}</div>`;
    }
    const cls = `${themeClass(this._config.theme, this._hass)} ${this._cardClass ? this._cardClass() : ""}`;
    const style = this.constructor.STYLE || "";
    this.shadowRoot.innerHTML = `${BASE_STYLE}${style}<ha-card class="${cls}">${body}</ha-card>`;
    this._after?.();
  }

  /** Historique d'une entité (courbe), la carte se redessine quand il arrive. */
  _hist(id, hours = 24) {
    if (!id) return null;
    this._histIds.push(id);
    return historyOf(this._hass, id, hours);
  }

  /** Enregistre une action et renvoie son numéro, pour data-a="…" (clic) ou data-h="…" (appui long). */
  _a(act) {
    if (!act || act.action === "none") return "";
    this._acts.push(act);
    return String(this._acts.length - 1);
  }

  /** Attributs d'un élément cliquable : clic, appui long, accessibilité. */
  _click(tap, hold, label) {
    const t = this._a(tap);
    const h = this._a(hold);
    let s = "";
    if (t !== "") s += ` data-a="${t}"`;
    if (h !== "") s += ` data-h="${h}"`;
    if (s) s += ` role="button" tabindex="0"`;
    if (label) s += ` aria-label="${esc(label)}"`;
    return s;
  }

  /** Action de la configuration (tap_action…), ou action par défaut. */
  _cfgAct(cfg, def, entity) {
    if (cfg === undefined || cfg === null) return def ? { entity, ...def } : null;
    if (typeof cfg === "string") return { action: cfg, entity };
    return { entity, ...cfg };
  }

  _setup() {
    this.attachShadow({ mode: "open" });
    const root = this.shadowRoot;
    let timer = null;
    let held = false;
    let start = null;
    root.addEventListener("pointerdown", (ev) => {
      held = false;
      if (ev.target.closest?.("input[type=range]")) this._busy = true;
      const el = ev.target.closest?.("[data-h]");
      if (!el) return;
      start = [ev.clientX, ev.clientY];
      clearTimeout(timer);
      timer = setTimeout(() => {
        held = true;
        this._run(Number(el.dataset.h), el);
      }, 500);
    });
    root.addEventListener("pointermove", (ev) => {
      if (start && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) > 12) clearTimeout(timer);
    });
    const end = () => {
      clearTimeout(timer);
      start = null;
      if (this._busy) {
        this._busy = false;
        setTimeout(() => this._update(true), 50);
      }
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.addEventListener("click", (ev) => {
      if (held) { held = false; ev.stopPropagation(); return; }
      const el = ev.target.closest?.("[data-a]");
      if (!el) return;
      ev.stopPropagation();
      this._run(Number(el.dataset.a), el);
    });
    root.addEventListener("change", (ev) => {
      const el = ev.target.closest?.("[data-chg]");
      if (el) this._run(Number(el.dataset.chg), el, el.value);
    });
    root.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.("[role=button]")) {
        ev.preventDefault();
        ev.target.click();
      }
    });
    root.addEventListener("contextmenu", (ev) => { if (ev.target.closest?.("[data-h]")) ev.preventDefault(); });
  }

  _run(i, el, value) {
    const act = this._acts?.[i];
    if (!act) return;
    if (act.confirm) {
      const key = `${i}:${act.entity || act.perform_action || act.service || ""}`;
      if (this._ui.confirm !== key) {
        this._ui = { ...this._ui, confirm: key };
        this._update(true);
        clearTimeout(this._confirmTimer);
        this._confirmTimer = setTimeout(() => { this._ui = { ...this._ui, confirm: null }; this._update(true); }, 3000);
        return;
      }
      this._ui = { ...this._ui, confirm: null };
    }
    this._exec(act, value);
  }

  _exec(act, value) {
    const h = this._hass;
    const e = act.entity;
    switch (act.action) {
      case "fn":
        act.fn(value);
        break;
      case "ui":
        this._ui = { ...this._ui, ...act.set };
        this._update(true);
        break;
      case "toggle": {
        const d = domainOf(e);
        if (d === "lock") h.callService("lock", h.states[e]?.state === "locked" ? "unlock" : "lock", { entity_id: e });
        else if (d === "button" || d === "input_button") h.callService(d, "press", { entity_id: e });
        else if (d === "scene" || d === "script") h.callService(d, "turn_on", { entity_id: e });
        else h.callService("homeassistant", "toggle", { entity_id: e });
        break;
      }
      case "more-info":
        if (e) fire(this, "hass-more-info", { entityId: e });
        break;
      case "navigate":
        navigate(act.navigation_path || act.path);
        break;
      case "url":
        window.open(act.url_path || act.url, "_blank", "noopener");
        break;
      case "call-service":
      case "perform-action": {
        const svc = act.perform_action || act.service;
        if (!svc || !svc.includes(".")) break;
        const [d, s] = svc.split(".");
        const data = { ...(act.data || act.service_data || {}) };
        if (value !== undefined && act.value_key) data[act.value_key] = act.value_num ? Number(value) : value;
        h.callService(d, s, data, act.target);
        break;
      }
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------ éditeur visuel */

const THEME_SELECT = {
  name: "theme",
  selector: {
    select: {
      mode: "dropdown",
      options: [
        { value: "maison", label: "Pastel : suit votre thème Home Assistant, avec des touches pastel" },
        { value: "v2", label: "Style MyElectricalData (bleu nuit)" },
        { value: "auto", label: "Style MyElectricalData, clair ou sombre selon Home Assistant" },
        { value: "ha", label: "Thème Home Assistant" },
        { value: "obd", label: "Tableau de bord OBD (cadrans noirs chromés, chiffres bleus)" },
      ],
    },
  },
};

/** Éditeur : formulaire Home Assistant. Les options absentes du formulaire (listes en YAML) sont conservées. */
function makeEditor(schema, labels, defaults, helper) {
  return class extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._draw();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass;
      else this._draw();
    }

    _draw() {
      if (!this._hass || !this._config) return;
      if (!this._form) {
        if (helper) {
          const p = document.createElement("p");
          p.style.cssText = "margin:0 0 12px;font-size:.88rem;color:var(--secondary-text-color)";
          p.textContent = helper;
          this.appendChild(p);
        }
        this._form = document.createElement("ha-form");
        this._form.computeLabel = (s) => labels[s.name] || s.name;
        this._form.addEventListener("value-changed", (ev) => {
          const v = { ...this._config, ...ev.detail.value };
          for (const k of Object.keys(v)) {
            if (v[k] === "" || v[k] === undefined || (k in defaults && v[k] === defaults[k] && !(k in this._config))) delete v[k];
          }
          this._config = v;
          this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: v }, bubbles: true, composed: true }));
        });
        this.appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.schema = typeof schema === "function" ? schema(this._config) : schema;
      this._form.data = { ...defaults, ...this._config };
    }
  };
}

/* ======================================================= outils « appareil » */

/** Entités d'un même appareil (registre), sinon de même préfixe d'entity_id. */
function poolOf(hass, anchor, prefix) {
  const ids = Object.keys(hass.states);
  const dev = anchor ? regOf(hass, anchor)?.device_id : null;
  if (dev) {
    const p = ids.filter((id) => regOf(hass, id)?.device_id === dev);
    if (p.length > 1) return p;
  }
  const pre = prefix || (anchor ? anchor.split(".")[1].split("_")[0] : null);
  return pre ? ids.filter((id) => id.split(".")[1].startsWith(pre)) : [];
}
const pick = (pool, domain, re, not) => pool.find((id) => domainOf(id) === domain && re.test(id.split(".")[1]) && !(not && not.test(id.split(".")[1]))) || null;

/** Tuile de valeur : libellé, grande valeur, barre facultative. */
const tileHtml = (label, value, unit, bar, barColor, extra = "") =>
  `<div class="vt2"${extra}><div class="vt2-l">${label}</div><div class="vt2-v">${value}${unit ? `<span>${unit}</span>` : ""}</div>` +
  `${bar !== null && bar !== undefined ? `<div class="bar-p"><i style="width:${Math.max(0, Math.min(100, bar))}%;background:${barColor || "var(--m-pop)"}"></i></div>` : ""}</div>`;

const DEVICE_STYLE = `
.dv { padding: 16px; }
.dv-h { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.dv-ic { width: 48px; height: 48px; border-radius: 50%; background: var(--m-chip); display: grid; place-items: center; flex: none; }
.dv-ic ha-icon { --mdc-icon-size: 28px; color: var(--m-acc); }
.dv-t { flex: 1; min-width: 0; }
.dv-n { font-size: 1.35em; font-weight: 500; letter-spacing: .3em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-s { font-size: .85rem; color: var(--m-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dv-g { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
.vt2 { background: var(--m-chip); border-radius: 16px; padding: 12px 12px 10px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.vt2-l { font-size: .78rem; color: var(--m-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vt2-v { font-size: 1.7rem; font-weight: 300; line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vt2-v span { font-size: .5em; margin-left: 3px; color: var(--m-muted); font-weight: 500; }
.vt2 .bar-p { margin-top: auto; height: 10px; }
.dv-alert { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 14px; background: var(--m-pop); color: var(--m-on-pop); margin-bottom: 12px; font-weight: 600; }
.dv-alert.err { background: var(--m-red); }
.dv-alert span { flex: 1; }
.dv-alert .rb { width: 36px; height: 36px; flex: none; background: rgba(255,255,255,.35); }
.dv-row { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
.dv-row .rbar { flex: 1; justify-content: space-around; }
.chipx { padding: 6px 12px; border-radius: 50px; background: var(--m-chip); font-size: .82rem; font-weight: 600; }
.chipx.on { background: var(--m-pop); color: var(--m-on-pop); }
.cam { margin-top: 12px; border-radius: 16px; overflow: hidden; background: var(--m-chip); aspect-ratio: 16 / 9; display: grid; place-items: center; }
.cam img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cam ha-icon { --mdc-icon-size: 40px; color: var(--m-muted); }
.btns { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 8px; margin-top: 12px; }
.btn { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px; border-radius: 18px; background: var(--m-pop); color: var(--m-on-pop); font-weight: 500; min-height: 70px; box-sizing: border-box; }
.btn.alt { background: var(--m-chip); color: var(--m-text); }
.btn.warn { background: var(--m-red); color: #fff; }
.btn.off { background: var(--m-chip); color: var(--m-muted); opacity: .55; pointer-events: none; }
`;

/* ======================================================= cadrans du tableau de bord */

// Arc de 270° (de 135° à 405°, sens horaire) : 0 en bas à gauche, maximum en bas à droite.
const gPt = (r, a) => [60 + r * Math.cos((a * Math.PI) / 180), 60 + r * Math.sin((a * Math.PI) / 180)];
const gArc = (r, a0, a1) => {
  const [x0, y0] = gPt(r, a0), [x1, y1] = gPt(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const clamp01 = (x) => (x === null || !Number.isFinite(x) ? null : Math.max(0, Math.min(1, x)));
/** Couleurs des cadrans : uniquement des variables du thème (jamais une valeur de capteur). */
const G_COLORS = { blue: "var(--m-pop)", green: "var(--m-green)", lime: "var(--m-lime, var(--m-green))", orange: "var(--m-orange)", red: "var(--m-red)", faint: "var(--m-faint)", yellow: "var(--m-yellow)" };

/** Lunette chromée et cadran noir du thème obd (masqués dans les autres thèmes). */
const OBD_BEZEL = `<defs><linearGradient id="vdChrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e9eef3"/><stop offset=".35" stop-color="#6c7580"/>` +
  `<stop offset=".55" stop-color="#20252b"/><stop offset=".8" stop-color="#8a939d"/><stop offset="1" stop-color="#d8dee4"/></linearGradient>` +
  `<radialGradient id="vdFace" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#1d232a"/><stop offset=".7" stop-color="#0a0d10"/><stop offset="1" stop-color="#030405"/></radialGradient></defs>` +
  `<g class="vd-o"><circle cx="60" cy="60" r="58.5" fill="url(#vdChrome)"/><circle cx="60" cy="60" r="55.5" fill="url(#vdFace)"/>` +
  `<circle class="vd-in" cx="60" cy="60" r="30" fill="url(#vdFace)" stroke="url(#vdChrome)" stroke-width="2.6"/></g>`;

/**
 * Cadran : arc de fond, zone rouge facultative, arc de valeur, graduations et aiguille facultatives.
 * frac, red (zone haute) et low (zone basse) sont des fractions (0 à 1) ; color est une clé de G_COLORS.
 */
function gaugeSvg(frac, color, { ticks = 0, red = null, low = null, needle = false, scale = null } = {}) {
  const f = clamp01(frac);
  const r = 48, a = (x) => 135 + 270 * x;
  let out = `<svg class="vd-arc" viewBox="0 0 120 104" aria-hidden="true">${OBD_BEZEL}<path class="vd-trk" d="${gArc(r, 135, 405)}"/>`;
  if (red !== null) out += `<path class="vd-red" d="${gArc(r, a(clamp01(red)), 405)}"/>`;
  if (low !== null && clamp01(low) > 0) out += `<path class="vd-red" d="${gArc(r, 135, a(clamp01(low)))}"/>`;
  if (f !== null && f > 0.004) out += `<path class="vd-val" style="stroke:${G_COLORS[color] || G_COLORS.blue}" d="${gArc(r, 135, a(f))}"/>`;
  for (let i = 0; i <= ticks; i++) {
    if (!ticks) break;
    const [x0, y0] = gPt(r - 9, a(i / ticks)), [x1, y1] = gPt(r - (i % 2 ? 12 : 15), a(i / ticks));
    out += `<line class="vd-tick${i % 2 ? "" : " maj"}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
  }
  if (Array.isArray(scale) && scale.length > 1) {
    let o = "";
    const n = scale.length - 1, sub = n <= 6 ? 4 : 2;
    for (let i = 0; i <= n * sub; i++) {
      const [x0, y0] = gPt(r + 6, a(i / (n * sub))), [x1, y1] = gPt(r + (i % sub ? 8 : 9.5), a(i / (n * sub)));
      o += `<line class="vd-ot${i % sub ? "" : " maj"}" x1="${x0.toFixed(2)}" y1="${y0.toFixed(2)}" x2="${x1.toFixed(2)}" y2="${y1.toFixed(2)}"/>`;
    }
    scale.forEach((v, i) => {
      const [x, y] = gPt(r - 13, a(i / n));
      o += `<text class="vd-on" x="${x.toFixed(2)}" y="${(y + 2.6).toFixed(2)}">${esc(v)}</text>`;
    });
    out += `<g class="vd-o">${o}</g>`;
  }
  out += `<circle class="vd-o vd-led" cx="60" cy="103" r="2.4"/>`;
  if (needle && f !== null) {
    const [x, y] = gPt(r - 16, a(f));
    out += `<line class="vd-ndl" x1="60" y1="60" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}"/><circle class="vd-hub" cx="60" cy="60" r="4.5"/>`;
  }
  return `${out}</svg>`;
}

/** Cadran avec sa valeur au centre et son libellé : value et unit arrivent déjà formatés et échappés. */
const dialHtml = (card, { label, value, unit = "", frac, color = "blue", id = null, big = false, ticks = 0, red = null, low = null, needle = false, sub = "", scale = null, short = "" }) =>
  `<div class="vd-g${big ? " big" : ""}"${id ? card._click({ action: "more-info", entity: id }, null, label) : ""}>` +
  `<div class="vd-gw">${gaugeSvg(frac, color, { ticks, red, low, needle, scale })}<div class="vd-gv${needle ? " low" : ""}"><em class="vd-gt">${short || label}</em><b>${value}</b>${unit ? `<span>${unit}</span>` : ""}${sub ? `<small>${sub}</small>` : ""}</div></div>` +
  `<div class="vd-gl">${label}</div></div>`;

/** Pastille d'information sous le tableau de bord. */
const pillHtml = (card, icon, text, id, cls = "") =>
  `<span class="vd-pill${cls ? ` ${cls}` : ""}"${id ? card._click({ action: "more-info", entity: id }, null, text.replace(/<[^>]+>/g, "")) : ""}><ha-icon icon="${icon}"></ha-icon>${text}</span>`;

/** En-tête d'un véhicule : icône, nom, sous-titre, état à droite. */
const carHead = (icon, name, sub, state, stateCls, extra = "") =>
  `<div class="vd-h"><div class="vd-ic ${stateCls}"><ha-icon icon="${icon}"></ha-icon></div><div class="vd-t"><div class="vd-n">${name}</div><div class="vd-s">${sub}</div></div>` +
  `${state ? `<span class="vd-st ${stateCls}"><i></i>${state}</span>` : ""}${extra}</div>`;

const DASH_STYLE = `
.vd { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.vd-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.vd-top > ha-icon { --mdc-icon-size: 30px; color: var(--m-acc); flex: none; }
.vd-top .vd-t { flex: 1; min-width: 0; }
.vd-ttl { font-size: 1.15rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-sub { font-size: .78rem; color: var(--m-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-sum { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
@container (max-width: 480px) { .vd-top:has(.vd-sum) { flex-wrap: wrap; } .vd-sum { flex-basis: 100%; justify-content: flex-start; } }
.vd-car { border: 1px solid var(--m-line); background: var(--m-chip); border-radius: 16px; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.vd-car.alert { border-color: var(--m-red); box-shadow: inset 0 0 0 1px var(--m-red); }
.vd-car.live { border-color: color-mix(in srgb, var(--m-pop) 55%, transparent); }
.vd-cars { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 10px; }
.vd-car.open { grid-column: 1 / -1; }
.vd-h { display: flex; align-items: center; gap: 10px; min-width: 0; }
.vd-h[data-a] { cursor: pointer; }
.vd-ic { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; flex: none; background: color-mix(in srgb, var(--m-text) 7%, transparent); }
.vd-ic ha-icon { --mdc-icon-size: 24px; color: var(--m-muted); }
.vd-ic.live ha-icon, .vd-ic.ch ha-icon { color: var(--m-pop); }
.vd-ic.ok ha-icon { color: var(--m-green); }
.vd-ic.alert ha-icon { color: var(--m-red); }
.vd-t { flex: 1; min-width: 0; }
.vd-n { font-weight: 700; font-size: 1rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-s { font-size: .76rem; color: var(--m-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-st { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: .76rem; font-weight: 600; white-space: nowrap; flex: none;
  border: 1px solid var(--m-line); background: color-mix(in srgb, var(--m-text) 4%, transparent); }
.vd-st i { width: 8px; height: 8px; border-radius: 50%; background: var(--m-faint); }
.vd-st.live i, .vd-st.ch i { background: var(--m-pop); box-shadow: 0 0 0 3px color-mix(in srgb, var(--m-pop) 25%, transparent); }
.vd-st.ok i { background: var(--m-green); }
.vd-st.alert { border-color: var(--m-red); color: var(--m-red); } .vd-st.alert i { background: var(--m-red); }
.vd-st.warn i { background: var(--m-orange); }
.vd-more { --mdc-icon-size: 20px; color: var(--m-muted); flex: none; }
/* tableau de bord : un grand cadran et des petits à côté */
.vd-dash { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 8px; align-items: center; }
.vd-dash.solo { grid-template-columns: 1fr; }
.vd-side { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
@container (max-width: 340px) { .vd-dash { grid-template-columns: 1fr; } .vd-side { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.vd-g { display: flex; flex-direction: column; align-items: center; min-width: 0; border-radius: 12px; padding: 2px 0 4px; }
.vd-g[data-a]:hover { background: color-mix(in srgb, var(--m-text) 4%, transparent); }
.vd-gw { position: relative; width: 100%; max-width: 92px; }
.vd-g.big .vd-gw { max-width: 190px; }
.vd-arc { display: block; width: 100%; height: auto; overflow: visible; }
.vd-trk { fill: none; stroke: var(--m-line); stroke-width: 8; stroke-linecap: round; }
.vd-red { fill: none; stroke: color-mix(in srgb, var(--m-red) 45%, transparent); stroke-width: 8; stroke-linecap: butt; }
.vd-val { fill: none; stroke-width: 8; stroke-linecap: round; transition: d .6s ease; }
.vd-g.big .vd-trk, .vd-g.big .vd-red, .vd-g.big .vd-val { stroke-width: 7; }
.vd-tick { stroke: var(--m-muted); stroke-width: 1; opacity: .55; }
.vd-tick.maj { stroke-width: 1.6; opacity: .9; }
.vd-ndl { stroke: var(--m-text); stroke-width: 2.4; stroke-linecap: round; }
.vd-hub { fill: var(--m-text); }
.vd-gv { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding-top: 6%; line-height: 1.05; text-align: center; }
.vd-gv.low { justify-content: flex-end; padding: 0 0 4%; }
.vd-gv b { font-size: 1.05rem; font-weight: 700; white-space: nowrap; }
.vd-g.big .vd-gv b { font-size: 2.1rem; }
.vd-gv span { font-size: .66rem; color: var(--m-muted); font-weight: 600; }
.vd-g.big .vd-gv span { font-size: .8rem; }
.vd-gv small { font-size: .72rem; color: var(--m-muted); margin-top: 2px; white-space: nowrap; }
.vd-gl { font-size: .72rem; color: var(--m-muted); margin-top: -4px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.vd-g.big .vd-gl { font-size: .8rem; margin-top: -10px; }
/* compteurs du trajet : chiffres façon afficheur */
.vd-trip { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 6px; }
.vd-k { border-radius: 10px; padding: 8px 10px; background: var(--m-card); border: 1px solid var(--m-line); min-width: 0; }
.vd-k small { display: block; font-size: .7rem; color: var(--m-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vd-k b { font-size: 1.05rem; font-weight: 700; white-space: nowrap; }
.vd-k b span { font-size: .7em; color: var(--m-muted); margin-left: 2px; font-weight: 600; }
.vd-k[data-a] { cursor: pointer; }
.vd-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.vd-pill { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 999px; background: var(--m-card); border: 1px solid var(--m-line); font-size: .76rem; font-weight: 600; white-space: nowrap; }
.vd-pill ha-icon { --mdc-icon-size: 16px; color: var(--m-muted); }
.vd-pill.warn { border-color: var(--m-orange); } .vd-pill.warn ha-icon { color: var(--m-orange); }
.vd-pill.alert { border-color: var(--m-red); color: var(--m-red); } .vd-pill.alert ha-icon { color: var(--m-red); }
.vd-pill.odo { font-variant-numeric: tabular-nums; letter-spacing: .04em; }
.vd-pill.off { color: var(--m-muted); font-weight: 500; }
.vd-none { font-size: .82rem; color: var(--m-muted); padding: 2px; }
/* éléments propres au thème obd */
.vd-o, .vd-gt { display: none; }
ha-card.th-obd .vd-o { display: inline; }
ha-card.th-obd .vd-gw { margin: 4px 0 11%; }
ha-card.th-obd .vd-trk { stroke: #14181d; stroke-width: 9; stroke-linecap: butt; }
ha-card.th-obd .vd-val { stroke: var(--m-red) !important; stroke-width: 9; stroke-linecap: butt; filter: drop-shadow(0 0 2px rgba(255, 36, 20, .85)); }
ha-card.th-obd .vd-red, ha-card.th-obd .vd-tick, ha-card.th-obd .vd-ndl, ha-card.th-obd .vd-hub { display: none; }
ha-card.th-obd .vd-ot { stroke: var(--m-lcd); stroke-width: .8; opacity: .55; }
ha-card.th-obd .vd-ot.maj { stroke-width: 1.4; opacity: 1; }
ha-card.th-obd .vd-on { fill: var(--m-lcd); font-size: 7.5px; font-style: italic; text-anchor: middle; font-family: var(--m-lcd-font); }
ha-card.th-obd .vd-led { fill: var(--m-green); filter: drop-shadow(0 0 2px var(--m-green)); }
ha-card.th-obd { --m-lcd-font: "DS-Digital", "Digital-7", "Orbitron", "Share Tech Mono", ui-monospace, "Consolas", monospace; }
ha-card.th-obd .vd-gv, ha-card.th-obd .vd-gv.low { justify-content: center; padding: 6% 0 0; color: var(--m-lcd); font-family: var(--m-lcd-font); text-shadow: 0 0 6px rgba(76, 195, 255, .55); }
ha-card.th-obd .vd-gv b { font-style: italic; font-weight: 600; letter-spacing: .02em; font-size: 1rem; }
ha-card.th-obd .vd-g.big .vd-gv b { font-size: 1.9rem; }
ha-card.th-obd .vd-g { container-type: inline-size; }
@container (max-width: 120px) { ha-card.th-obd .vd-on { display: none; } ha-card.th-obd .vd-gv b { font-size: .9rem; } ha-card.th-obd .vd-gt { font-size: .48rem; } }
ha-card.th-obd .vd-gv span, ha-card.th-obd .vd-gv small { color: var(--m-lcd); font-style: italic; text-transform: uppercase; }
ha-card.th-obd .vd-gt { display: block; font-style: italic; font-size: .55rem; text-transform: uppercase; letter-spacing: .04em; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
ha-card.th-obd .vd-g.big .vd-gt { font-size: .62rem; }
ha-card.th-obd .vd-g:not(.big) .vd-gt { max-width: 50%; }
ha-card.th-obd .vd-gl { display: none; }
ha-card.th-obd .vd-g:not(.big) .vd-gv span { font-size: .5rem; }
ha-card.th-obd .vd-car { background: linear-gradient(180deg, #0d1115, #07090b); border-color: #1d242d; }
ha-card.th-obd .vd-k, ha-card.th-obd .vd-pill { background: #07090c; border-color: #1d242d; }
ha-card.th-obd .vd-k b { color: var(--m-lcd); font-family: var(--m-lcd-font); font-style: italic; text-shadow: 0 0 6px rgba(76, 195, 255, .45); }
`;


const levelBar = (v, hi = 60, lo = 35) => (v === null ? null : v >= hi ? "var(--m-green)" : v <= lo ? "var(--m-pop)" : "var(--m-orange)");

/* ================================================================ voiture */

const CAR_PLATFORMS = ["tesla_fleet", "teslemetry", "tessie", "tesla_custom", "tesla"];

class MaisonVoitureCard extends MaisonCard {
  static get DEFAULTS() { return { theme: "v2", icon: "mdi:car-electric" }; }

  _resolve(c, hass) {
    let anchor = c.battery || null;
    if (!anchor && !c.prefix) {
      anchor = Object.keys(hass.states).find((id) => domainOf(id) === "sensor" && CAR_PLATFORMS.includes(regOf(hass, id)?.platform) && /battery_level|battery$|_soc$/.test(id)) || null;
    }
    const pool = anchor || c.prefix ? poolOf(hass, anchor, c.prefix) : [];
    const f = (k, dom, re, not) => (c[k] !== undefined ? c[k] : pick(pool, dom, re, not));
    return {
      battery: c.battery !== undefined ? c.battery : anchor || pick(pool, "sensor", /battery_level|_battery$|batterie|_soc$|state_of_charge/, /range|temp|voltage/),
      range: f("range", "sensor", /range|autonomie/, /ideal|est_|target/),
      odometer: f("odometer", "sensor", /odometer|kilometrage|mileage|odometre/),
      charging: c.charging !== undefined ? c.charging : pick(pool, "binary_sensor", /charging$|en_charge$|is_charging/) || pick(pool, "sensor", /charging_state|charging_status|charge_state|etat_de_charge/),
      plugged: f("plugged", "binary_sensor", /charger$|charge_cable|plugged|branche|cable|charger_connected/),
      power: f("charger_power", "sensor", /charger_power|charging_power|charge_power|puissance_de_charge/),
      limit: f("charge_limit", "number", /charge_limit|limite_de_charge|charge_target/),
      climate: f("climate", "climate", /./),
      inside: f("inside_temp", "sensor", /inside_temp|interior_temp|temperature_interieure|cabin/),
      lock: f("lock", "lock", /./, /charge_port|frunk|trunk/),
      location: f("location", "device_tracker", /location|position|gps|./),
      switch: f("charge_switch", "switch", /charge$|charging$|_charger$/),
    };
  }

  _ids() { return Object.values(this._resolved()).filter((x) => typeof x === "string"); }

  _chargeText(r, hass) {
    const st = hass.states;
    const chRaw = r.charging ? st[r.charging]?.state : null;
    const pw = num(r.power ? st[r.power]?.state : null);
    const pwU = r.power ? st[r.power]?.attributes?.unit_of_measurement || "kW" : "kW";
    const pwKw = pw === null ? null : /^w$/i.test(pwU) ? pw / 1000 : pw;
    let charging = null;
    if (chRaw !== null && chRaw !== undefined) {
      if (domainOf(r.charging) === "binary_sensor") charging = chRaw === "on";
      else charging = /charging|inprogress|in_progress|en_charge|^on$/i.test(chRaw) ? true : /complete|termin/i.test(chRaw) ? "done" : false;
    }
    const plugged = r.plugged ? st[r.plugged]?.state === "on" : chRaw ? !/disconnected|not_?connected|unplugged|d[eé]branch/i.test(chRaw) : null;
    if (charging === true) return { txt: `En charge${pwKw !== null ? ` à ${fmt(pwKw, pwKw < 10 ? 1 : 0)} kW` : ""}`, on: true };
    if (charging === "done") return { txt: "Charge terminée", on: false };
    if (plugged === false) return { txt: "Débranchée", on: false };
    if (plugged === true) return { txt: "Branchée, en attente", on: false };
    return { txt: chRaw ? stateFr(chRaw) : "—", on: false };
  }

  _render(c, hass) {
    const r = this._resolved();
    const st = hass.states;
    if (!r.battery && !r.range) return `<div class="empty"><b>Voiture introuvable</b>Indiquez « battery: sensor.… » (et les autres capteurs) ou « prefix ».</div>`;
    const bat = num(st[r.battery]?.state);
    const rng = num(st[r.range]?.state);
    const odo = num(st[r.odometer]?.state);
    const ch = this._chargeText(r, hass);
    const lim = num(st[r.limit]?.state);
    const pw = num(r.power ? st[r.power]?.state : null);
    const pwU = r.power ? st[r.power]?.attributes?.unit_of_measurement || "kW" : "kW";
    const pwKw = pw === null ? null : /^w$/i.test(pwU) ? pw / 1000 : pw;
    const rngU = esc(st[r.range]?.attributes?.unit_of_measurement || "km");
    const batColor = bat === null ? "faint" : ch.on ? "blue" : bat <= 20 ? "red" : bat <= 40 ? "orange" : "green";
    const big = dialHtml(this, { label: lim !== null ? `Batterie · limite ${fmt(lim)} %` : "Batterie", value: bat !== null ? fmt(bat) : "—", unit: "%",
      sub: rng !== null ? `${fmt(rng)} ${rngU}` : "", frac: bat === null ? null : bat / 100, color: batColor, big: true, ticks: 10, low: 0.2, id: r.battery || r.range, short: "Batterie", scale: [0, 20, 40, 60, 80, 100] });
    const side = [
      rng !== null ? dialHtml(this, { label: "Autonomie", short: "Auton.", value: fmt(rng), unit: rngU, frac: bat === null ? null : bat / 100, color: batColor, id: r.range }) : "",
      pwKw !== null && ch.on ? dialHtml(this, { label: "Puissance", short: "Puiss.", value: fmt(pwKw, pwKw < 10 ? 1 : 0), unit: "kW", frac: pwKw / Math.max(11, num(c.max_power) || 11), color: "blue", id: r.power }) : "",
      lim !== null ? dialHtml(this, { label: "Limite de charge", short: "Limite", value: fmt(lim), unit: "%", frac: lim / 100, color: "faint", id: r.limit }) : "",
    ].filter(Boolean).join("");
    let clim = "";
    const cl = r.climate ? st[r.climate] : null;
    if (cl) {
      const on = cl.state !== "off";
      const t = num(cl.attributes?.temperature);
      const inside = num(r.inside ? st[r.inside]?.state : cl.attributes?.current_temperature);
      const step = num(cl.attributes?.target_temp_step) || 0.5;
      const set = (v) => ({ action: "perform-action", perform_action: "climate.set_temperature", target: { entity_id: r.climate }, data: { temperature: v } });
      clim = `<div class="cl"><div class="cl-t"${this._click({ action: "more-info", entity: r.climate }, null, "Climatisation")}><small>Climatisation · intérieur ${fmt(inside, 1)} °C</small>` +
        `<span class="cl-v">${on ? `${fmt(t, 1)}<span>°C</span>` : "Arrêtée"}</span></div><div class="rbar">` +
        `${on && t !== null ? `<span class="rb"${this._click(set(t - step), null, "Moins")}><ha-icon icon="mdi:minus"></ha-icon></span><span class="rb"${this._click(set(t + step), null, "Plus")}><ha-icon icon="mdi:plus"></ha-icon></span>` : ""}` +
        `<span class="rb${on ? " on" : ""}"${this._click({ action: "perform-action", perform_action: on ? "climate.turn_off" : "climate.turn_on", target: { entity_id: r.climate } }, null, on ? "Arrêter" : "Démarrer")}><ha-icon icon="mdi:fan"></ha-icon></span></div></div>`;
    }
    let lock = "";
    const lk = r.lock ? st[r.lock] : null;
    if (lk) {
      const locked = lk.state === "locked";
      const pending = this._ui.confirm?.endsWith?.(r.lock);
      lock = `<span class="rb vd-lock${locked ? "" : " warn"}"${this._click({ action: "toggle", entity: r.lock, confirm: locked }, { action: "more-info", entity: r.lock }, locked ? "Déverrouiller (deux clics)" : "Verrouiller")} title="${locked ? "Verrouillée" : "Déverrouillée"}"><ha-icon icon="${pending ? "mdi:lock-question" : locked ? "mdi:lock" : "mdi:lock-open-variant"}"></ha-icon></span>`;
    }
    const loc = r.location ? st[r.location] : null;
    const where = loc ? (loc.state === "home" ? "À la maison" : loc.state === "not_home" ? "En déplacement" : stateFr(loc.state)) : "";
    const chargeAct = r.switch ? this._click({ action: "toggle", entity: r.switch }, { action: "more-info", entity: r.switch }, "Démarrer / arrêter la charge") : r.charging ? this._click({ action: "more-info", entity: r.charging }, null, "Charge") : "";
    const pills = [
      `<span class="vd-pill${ch.on ? " on" : ""}"${chargeAct}><ha-icon icon="${ch.on ? "mdi:ev-station" : "mdi:power-plug-outline"}"></ha-icon>${esc(ch.txt)}</span>`,
      odo !== null ? pillHtml(this, "mdi:counter", `${fmt(odo)} ${esc(st[r.odometer]?.attributes?.unit_of_measurement || "km")}`, r.odometer, "odo") : "",
    ].join("");
    const stCls = ch.on ? "ch" : bat !== null && bat <= 20 ? "alert" : "ok";
    return `<div class="vd">${carHead(esc(c.icon), tpl(c.name ?? "Voiture", hass), esc(where || ch.txt), ch.on ? "En charge" : bat !== null && bat <= 20 ? "Batterie faible" : "Prête", stCls, lock)}` +
      `<div class="vd-dash${side ? "" : " solo"}">${big}${side ? `<div class="vd-side ev">${side}</div>` : ""}</div><div class="vd-pills">${pills}</div>${clim}</div>`;
  }

  getCardSize() { return 5; }
}
MaisonVoitureCard.STYLE = `<style>${DASH_STYLE}
.vd-side.ev { grid-template-columns: 1fr; }
@container (max-width: 340px) { .vd-side.ev { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.vd-pill.on { border-color: var(--m-pop); color: var(--m-pop); } .vd-pill.on ha-icon { color: var(--m-pop); }
.vd-pill[data-a] { cursor: pointer; }
.vd-lock { flex: none; width: 40px; height: 40px; background: var(--m-chip); border: 1px solid var(--m-line); }
.vd-lock.warn { background: var(--m-red); color: #fff; border-color: var(--m-red); }
.cl { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: 14px; background: var(--m-chip); border: 1px solid var(--m-line); }
.cl-t { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cl-t small { font-size: .74rem; color: var(--m-muted); }
.cl-v { font-size: 1.5rem; font-weight: 700; }
.cl-v span { font-size: .55em; margin-left: 2px; color: var(--m-muted); }
.cl .rbar { background: var(--m-card); flex: none; }
.cl .rb { width: 40px; height: 40px; flex: none; }
</style>`;

/* ================================================ style des listes de véhicules */

const TEL_STYLE = `<style>${DEVICE_STYLE}
.dv-n { letter-spacing: normal; }
.tel-sum { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
@container (max-width: 480px) { .dv-h:has(.tel-sum) { flex-wrap: wrap; } .tel-sum { flex-basis: 100%; justify-content: flex-start; } }
.chipx.warn { background: var(--m-red); color: var(--m-on-pop); }
.tel-g { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.tel { background: var(--m-chip); border-radius: 16px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.tel.low { box-shadow: inset 0 0 0 2px var(--m-red); }
.tel.open { grid-column: 1 / -1; }
.tel.muted .tel-h, .tel.muted .tel-bar { opacity: .5; }
.tel.muted .tel-ic ha-icon { color: var(--m-muted); }
.tel-h { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tel-ic { position: relative; width: 38px; height: 38px; border-radius: 50%; background: var(--m-card); display: grid; place-items: center; flex: none; }
.tel-ic ha-icon { --mdc-icon-size: 22px; color: var(--m-acc); }
.tel-ic .tel-bolt { position: absolute; right: -4px; bottom: -4px; --mdc-icon-size: 16px; color: var(--m-yellow); }
.tel-t { flex: 1; min-width: 0; }
.tel-n { font-weight: 600; font-size: .95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tel-s { font-size: .76rem; color: var(--m-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tel-b { font-size: 1.5rem; font-weight: 300; white-space: nowrap; }
.tel-b span { font-size: .55em; color: var(--m-muted); margin-left: 2px; }
.tel-b.low { color: var(--m-red); font-weight: 500; }
.tel-bar { height: 6px; }
.tel-d { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 12px; padding-top: 4px; border-top: 1px solid var(--m-line); }
.tel-r { display: flex; align-items: center; gap: 8px; font-size: .8rem; padding: 4px 2px; min-width: 0; }
.tel-r ha-icon { --mdc-icon-size: 18px; color: var(--m-muted); flex: none; }
.tel-r span { color: var(--m-muted); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tel-r b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
</style>`;

/* ===================================================== batteries de voiture */

const BM_PLATFORMS = ["bm6", "bm2", "bm7", "battery_monitor"];
const BM_FR = {
  charging: "En charge", discharging: "Au repos", resting: "Au repos", idle: "Au repos", static: "Au repos", cranking: "Démarrage",
  normal: "Normale", low_voltage: "Tension basse", high_voltage: "Tension haute", low_battery: "Batterie faible", engine_running: "Moteur en marche",
};
const BM_STATES = /^(charging|discharging|resting|idle|static|cranking)$/;

class MaisonBatteriesCard extends MaisonCard {
  static get DEFAULTS() { return { theme: "v2", title: "Batteries voitures", volt_warn: 12.3, volt_alert: 12, hours: 48, stale_hours: 3, show_curve: true }; }

  /** Un appareil par batterie ; rôles d'après la classe du capteur, l'identifiant et la valeur (entités renommées comprises). */
  _resolve(c, hass) {
    const reg = hass.entities || {}, devs = hass.devices || {};
    const only = [].concat(c.devices || []).map((x) => String(x).toLowerCase());
    const map = {};
    for (const [id, e] of Object.entries(reg)) {
      if (!BM_PLATFORMS.includes(e.platform) || domainOf(id) !== "sensor" || !hass.states[id]) continue;
      const dev = devs[e.device_id];
      const name = dev?.name_by_user || dev?.name || "Batterie";
      if (only.length && !only.includes(name.toLowerCase()) && !only.includes(e.device_id)) continue;
      const d = (map[e.device_id || id] ||= { id: e.device_id || id, name, roles: {} });
      const o = hass.states[id], a = o.attributes || {}, dc = a.device_class;
      const txt = `${id} ${a.friendly_name || ""}`.toLowerCase();
      const fromDevice = /device|appareil|\(bm\d\)/.test(txt);
      let role = null;
      if (dc === "voltage") role = "volt";
      else if (dc === "temperature") role = "temp";
      else if (dc === "signal_strength") role = "rssi";
      else if (dc === "battery") role = fromDevice && !("state_algorithm" in a) ? "pct_dev" : "pct";
      else if (/lenteur|deceleration|baisse/.test(txt)) role = "drop";
      else if (/acceleration|hausse/.test(txt)) role = "rise";
      else if (/skaner|scanner/.test(txt) || /\(([0-9a-f]{2}:){5}[0-9a-f]{2}\)/i.test(o.state)) role = "proxy";
      else if (/condition/.test(txt) || (fromDevice && !BM_STATES.test(o.state))) role = "cond";
      else if (BM_STATES.test(o.state) || /_(stan|state|etat)$/.test(id)) role = "state";
      if (role && !d.roles[role]) d.roles[role] = id;
    }
    const list = Object.values(map).filter((d) => d.roles.volt || d.roles.pct);
    list.sort((a, b) => (only.length ? only.indexOf(a.name.toLowerCase()) - only.indexOf(b.name.toLowerCase()) : 0) || a.name.localeCompare(b.name, "fr", { numeric: true }));
    return { list };
  }

  _ids() { return this._resolved().list.flatMap((d) => Object.values(d.roles)); }

  _render(c, hass) {
    const { list } = this._resolved();
    if (!list.length) return `<div class="empty"><b>Aucune batterie</b>Ajoutez vos boîtiers BM6 (intégration Battery Monitor BM6, HACS) ; ils sont trouvés seuls.</div>`;
    const st = hass.states;
    const val = (id) => { const s = id ? st[id]?.state : undefined; return s === undefined || BAD.has(s) ? null : s; };
    const warn = num(c.volt_warn) ?? 12.3, alert = num(c.volt_alert) ?? 12;
    const hours = num(c.hours) || 48;
    const staleMs = (num(c.stale_hours) ?? 3) * 3600e3;
    const open = this._ui.bat;
    let lowN = 0, awayN = 0;
    const tiles = list.map((d) => {
      const r = d.roles;
      const v = num(val(r.volt)), pct = num(val(r.pct)) ?? num(val(r.pct_dev));
      const seenAt = Math.max(0, ...[r.volt, r.pct].filter(Boolean).map((id) => Math.max(Date.parse(st[id]?.last_reported || 0) || 0, Date.parse(st[id]?.last_updated || 0) || 0)));
      const away = staleMs > 0 && seenAt > 0 && Date.now() - seenAt > staleMs;
      const stTxt = String(val(r.state) || "").toLowerCase();
      const cond = String(val(r.cond) || "").toLowerCase();
      const running = v !== null && v >= 13.2;
      const charging = !away && (stTxt === "charging" || running);
      const level = v === null ? null : charging ? "ch" : v < alert ? "alert" : v < warn ? "warn" : "ok";
      const lowV = !away && (level === "alert" || level === "warn" || cond === "low_voltage");
      if (lowV) lowN++;
      if (away) awayN++;
      const color = away ? "var(--m-faint)" : level === "alert" ? "var(--m-red)" : level === "warn" || cond === "low_voltage" ? "var(--m-orange)" : charging ? "var(--m-acc)" : "var(--m-green)";
      const temp = num(val(r.temp));
      const sub = away
        ? `Hors de portée ${relTime(new Date(seenAt).toISOString()) || ""}`.replace("il y a", "depuis")
        : [running ? "Moteur en marche" : BM_FR[stTxt] || (stTxt ? stTxt.replace(/_/g, " ") : null), temp !== null ? `${fmt(temp)} °C` : null, seenAt ? relTime(new Date(seenAt).toISOString()) : null].filter(Boolean).join(" · ");
      // courbe de tension et son creux sur la période
      let graph = "";
      if (c.show_curve !== false && r.volt) {
        const pts = this._hist(r.volt, hours);
        if (pts && pts.length > 1) {
          // échelle de la tension au repos : les trajets (alternateur, 13,2 V et plus) sont écrêtés et comptés à part
          const rest = pts.map((p) => p[1]).filter((x) => x < 13.2);
          const lo = rest.length ? Math.min(...rest) : null, top = rest.length ? Math.max(...rest) : null;
          let trips = 0;
          pts.forEach((p, i) => { if (p[1] >= 13.2 && (i === 0 || pts[i - 1][1] < 13.2)) trips++; });
          const shown = top === null ? pts : pts.map((p) => [p[0], Math.min(p[1], top + 0.15)]);
          graph = `<div class="bat-g">${spark(shown, 300, 46, hours, 0.3)}<div class="bat-gl"><span>${hours} h</span><span>${[lo !== null ? `creux ${fmt(lo, 2)} V` : null, trips ? `${trips} trajet${trips > 1 ? "s" : ""}` : null].filter(Boolean).join(" · ")}</span></div></div>`;
        }
      }
      const isOpen = open === d.id;
      let detail = "";
      if (isOpen) {
        const proxy = val(r.proxy) ? String(val(r.proxy)).replace(/\s*\(([0-9a-f]{2}:){5}[0-9a-f]{2}\)\s*$/i, "") : null;
        const rows = [
          ["mdi:battery-heart-variant", "Charge calculée", pct !== null && num(val(r.pct)) !== null ? `${fmt(num(val(r.pct)))} %` : null, r.pct],
          ["mdi:battery-outline", "Charge selon le BM6", num(val(r.pct_dev)) !== null ? `${fmt(num(val(r.pct_dev)))} %` : null, r.pct_dev],
          ["mdi:car-battery", "État du BM6", cond ? BM_FR[cond] || cond.replace(/_/g, " ") : null, r.cond],
          ["mdi:thermometer", "Température", temp !== null ? `${fmt(temp, 1)} °C` : null, r.temp],
          ["mdi:trending-down", "Baisses rapides de tension", val(r.drop), r.drop],
          ["mdi:trending-up", "Hausses rapides de tension", val(r.rise), r.rise],
          ["mdi:bluetooth", "Signal", num(val(r.rssi)) !== null ? `${fmt(num(val(r.rssi)))} dBm${proxy ? ` via ${proxy}` : ""}` : proxy, r.rssi || r.proxy],
          ["mdi:clock-outline", "Dernière mesure", seenAt ? new Date(seenAt).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null, r.volt],
        ].filter(([, , x]) => x !== null && x !== undefined && x !== "");
        detail = `<div class="tel-d">${rows.map(([ic, l, x, id]) => `<div class="tel-r"${this._click({ action: "more-info", entity: id }, null, l)}><ha-icon icon="${ic}"></ha-icon><span>${l}</span><b>${esc(x)}</b></div>`).join("")}</div>`;
      }
      const vColor = away ? "faint" : level === "alert" ? "red" : level === "warn" || cond === "low_voltage" ? "orange" : charging ? "blue" : "green";
      const gauge = dialHtml(this, { label: pct !== null ? `${fmt(pct)} %` : "Tension", value: v === null ? "—" : fmt(v, 2), unit: "V",
        frac: v === null ? null : (v - 11) / 3.8, color: vColor, low: (alert - 11) / 3.8 });
      const head = carHead(charging ? "mdi:car-battery" : "mdi:car-battery", esc(d.name), esc(sub), away ? "Hors de portée" : level === "alert" ? "Critique" : lowV ? "Basse" : charging ? "En charge" : "Bonne",
        away ? "" : level === "alert" ? "alert" : lowV ? "warn" : charging ? "ch" : "ok",
        `<ha-icon class="vd-more" icon="${isOpen ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>`)
        .replace('<div class="vd-h">', `<div class="vd-h"${this._click({ action: "ui", set: { bat: isOpen ? null : d.id } }, { action: "more-info", entity: r.volt || r.pct }, d.name)}>`);
      return `<div class="vd-car bat${isOpen ? " open" : ""}${level === "alert" && !away ? " alert" : ""}${away ? " muted" : ""}">${head}
        <div class="vd-bat">${gauge}${graph || (pct !== null ? `<div class="bat-p"><div class="bar-p"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${G_COLORS[vColor]}"></i></div></div>` : "")}</div>
        ${detail}
      </div>`;
    }).join("");
    const sum = [lowN ? `<span class="vd-st alert"><i></i>${lowN} tension basse</span>` : "", awayN ? `<span class="vd-st"><i></i>${awayN} hors de portée</span>` : ""].join("");
    return `<div class="vd"><div class="vd-top"><ha-icon icon="${esc(c.icon || "mdi:car-battery")}"></ha-icon><div class="vd-t"><div class="vd-ttl">${tpl(c.title ?? "Batteries voitures", hass)}</div>` +
      `<div class="vd-sub">${list.length} batterie${list.length > 1 ? "s" : ""} 12 V</div></div>${sum ? `<div class="vd-sum">${sum}</div>` : ""}</div>` +
      `<div class="vd-cars">${tiles}</div></div>`;
  }

  getCardSize() { return 4; }
}
MaisonBatteriesCard.STYLE = TEL_STYLE + `<style>${DASH_STYLE}
.vd-bat { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 10px; align-items: center; }
.vd-bat .vd-gw { max-width: 104px; }
.vd-bat .vd-gv b { font-size: 1.15rem; }
.bat-p .bar-p { height: 8px; }
.bat-g { height: 72px; display: grid; grid-template-rows: 52px auto; min-width: 0; }
.bat-gl { display: flex; justify-content: space-between; gap: 6px; font-size: .7rem; color: var(--m-muted); }
.bat-gl span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vd-car.muted .vd-bat { opacity: .5; }
.vd-st.warn { border-color: var(--m-orange); }
.tel-d { border-top: 1px solid var(--m-line); }
</style>`;

/* ================================================ voitures thermiques (Torque) */

// rôles d'après la clé Torque normalisée (attribut « pid » des capteurs de l'intégration Torque OBD-II)
const TQ_PIDS = {
  k0d: "speed", kff1001: "gps_speed", k0c: "rpm", k05: "coolant", k0f: "intake", k04: "load", k11: "throttle", k2f: "fuel",
  k21: "mil_km", kff1238: "obd_volt", kff1204: "trip_km", kff1268: "trip_moving", kff1266: "trip_time", kff1272: "trip_avg",
  kff1208: "trip_l100", kff1207: "l100", kff5203: "l100_long", kff1258: "co2", kff1225: "torque", kff1226: "hp", kff129a: "phone",
};
// PID propres au véhicule (définitions personnalisées Torque) : Renault Laguna III (Mode 22) et Mercedes SLK R170 (bloc 21 01)
const TQ_CUSTOM = {
  k222006: "odometer", k222201: "tank", k22287f: "tank", k222007: "oil", k2101_slktemp33: "oil", k2101_slkpres29: "boost",
  k2101_slkgear: "gear", k222057: "alternator", k222168: "starts",
};
// coordonnées GPS : jamais affichées (la carte ne montre que la zone)
const TQ_PRIVATE = new Set(["kff1005", "kff1006", "kff1010", "kff123b"]);
// secours quand le PID standard n'est pas lu
const TQ_FALLBACK = { k222003: "speed", k222002: "rpm", k222001: "coolant", k22240d: "intake" };
const tqPid = (p) => {
  p = String(p || "").toLowerCase();
  const h = p.slice(1);
  return p.startsWith("k") && /^[0-9a-f]+$/.test(h) && h.length < 2 ? `k${h.padStart(2, "0")}` : p;
};

class MaisonTorqueCard extends MaisonCard {
  static get DEFAULTS() { return { theme: "v2", title: "Voitures", show_battery: true, show_location: true, max_speed: 200, max_rpm: 7000 }; }

  _resolve(c, hass) {
    const reg = hass.entities || {}, devs = hass.devices || {};
    const only = [].concat(c.devices || []).map((x) => String(x).toLowerCase());
    const map = {};
    for (const [id, e] of Object.entries(reg)) {
      if (e.platform !== "torque_obd" || !hass.states[id] || !e.device_id) continue;
      const dev = devs[e.device_id];
      const name = dev?.name_by_user || dev?.name || "Voiture";
      if (only.length && !only.includes(name.toLowerCase()) && !only.includes(e.device_id)) continue;
      const d = (map[e.device_id] ||= { id: e.device_id, name, roles: {}, all: [] });
      const o = hass.states[id], dom = domainOf(id);
      if (dom === "binary_sensor") d.roles.connected ||= id;
      else if (dom === "device_tracker") d.roles.tracker ||= id;
      else if (dom === "sensor") {
        const pid = o.attributes?.pid;
        if (!pid) continue; // URL Torque
        const key = tqPid(pid);
        if (TQ_PRIVATE.has(key) || /latitude|longitude/i.test(o.attributes.friendly_name || "")) continue;
        d.all.push(id);
        const role = TQ_PIDS[key] || TQ_CUSTOM[key];
        const fn = String(o.attributes.friendly_name || "").toLowerCase();
        if (role && !d.roles[role]) d.roles[role] = id;
        else if (TQ_FALLBACK[key]) (d.fallback ||= {})[TQ_FALLBACK[key]] ||= id;
        // autres PID propres au véhicule, d'après leur nom
        else if (/kilom[ée]trage total|odom/.test(fn)) d.roles.odometer ||= id;
        else if (/carburant dans le r[ée]servoir/.test(fn)) d.roles.tank ||= id;
      }
    }
    for (const d of Object.values(map)) for (const [k, id] of Object.entries(d.fallback || {})) d.roles[k] ||= id;
    // batterie BM6 au nom du véhicule (« Batterie Renault » pour « Renault »)
    const bm = Object.entries(reg).filter(([id, e]) => ["bm6", "bm2", "bm7"].includes(e.platform) && hass.states[id]?.attributes?.device_class === "voltage");
    // un boîtier a deux capteurs de tension (mesurée et corrigée) : celui qui a une valeur, la tension corrigée d'abord
    const bestOf = (rows) => {
      const ids = rows.map(([id]) => id).sort((a, b) => Number(/corrig|corrected/.test(b)) - Number(/corrig|corrected/.test(a)));
      return ids.find((id) => num(hass.states[id]?.state) !== null) || ids[0] || null;
    };
    // batteries choisies à la main : { Mercedes: "Batterie SLK" } (nom de l'appareil BM6) ou { Mercedes: sensor.… } (capteur de tension)
    const chosen = Object.fromEntries(Object.entries(c.batteries && typeof c.batteries === "object" ? c.batteries : {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
    for (const d of Object.values(map)) {
      const want = chosen[d.name.toLowerCase()];
      if (want) {
        const id = hass.states[want] ? want : bestOf(bm.filter(([, e]) => String(devs[e.device_id]?.name_by_user || devs[e.device_id]?.name || "").toLowerCase() === want.toLowerCase()));
        if (id) { d.roles.battery = id; continue; }
      }
      // « Batterie Renault » ↔ « Renault Laguna » : le nom de la batterie sans « Batterie » doit figurer dans celui de la voiture, ou l'inverse
      const car = d.name.toLowerCase();
      const hit = bestOf(bm.filter(([, e]) => {
        const n = String(devs[e.device_id]?.name_by_user || devs[e.device_id]?.name || "").toLowerCase().replace(/\bbatterie\b|\bbattery\b/g, "").trim();
        return n && (car.includes(n) || n.includes(car));
      }));
      if (hit) d.roles.battery = hit;
    }
    const list = Object.values(map);
    list.sort((a, b) => (only.length ? only.indexOf(a.name.toLowerCase()) - only.indexOf(b.name.toLowerCase()) : 0) || a.name.localeCompare(b.name, "fr", { numeric: true }));
    return { list };
  }

  _ids() { return this._resolved().list.flatMap((d) => Object.values(d.roles)); }

  _render(c, hass) {
    const { list } = this._resolved();
    if (!list.length) return `<div class="empty"><b>Aucune voiture</b>Ajoutez vos véhicules avec l'intégration Torque OBD-II, puis faites un trajet avec Torque Pro.</div>`;
    const st = hass.states;
    const val = (id) => { const s = id ? st[id]?.state : undefined; return s === undefined || BAD.has(s) ? null : s; };
    const n = (id) => num(val(id));
    const pos = (id) => { const x = n(id); return x ? x : null; };
    const open = this._ui.car;
    const maxSpeed = Math.max(60, num(c.max_speed) || 200), maxRpm = Math.max(2000, num(c.max_rpm) || 7000);
    let driving = 0, mil = 0;
    const cars = list.map((d) => {
      const r = d.roles;
      const live = val(r.connected) === "on";
      if (live) driving++;
      const milKm = n(r.mil_km);
      if (milKm) mil++;
      const tr = r.tracker ? st[r.tracker] : null;
      const where = c.show_location !== false && tr && !BAD.has(tr.state)
        ? tr.state === "home" ? "À la maison" : tr.state === "not_home" ? "Absente" : (st[`zone.${tr.state}`]?.attributes?.friendly_name || tr.state.replace(/_/g, " "))
        : null;
      // fin du dernier trajet : déconnexion de Torque, sinon dernier changement de la distance du trajet
      const conn = r.connected ? st[r.connected] : null;
      const tripAt = conn && conn.state === "off" && !/^1970/.test(conn.last_changed || "") ? conn.last_changed
        : r.trip_km && st[r.trip_km] ? st[r.trip_km].last_changed : null;
      const sub = live ? [where, n(r.l100) !== null ? `${fmt(n(r.l100), 1)} L/100` : null].filter(Boolean).join(" · ")
        : [where, tripAt ? `dernier trajet ${relTime(tripAt)}` : null].filter(Boolean).join(" · ");
      const k = (l, v, u, id) => (v === null ? "" : `<div class="vd-k"${this._click({ action: "more-info", entity: id }, null, l)}><small>${l}</small><b>${v}${u ? `<span>${u}</span>` : ""}</b></div>`);
      const cool = n(r.coolant), oil = n(r.oil), boost = n(r.boost), gear = n(r.gear);
      const temp = (x, hot) => (x === null ? "faint" : x >= hot ? "red" : x < 60 ? "blue" : "green");
      let main;
      if (live) {
        const spd = n(r.speed) ?? n(r.gps_speed), rpm = n(r.rpm);
        const side = [
          dialHtml(this, { label: "Régime", value: rpm !== null ? fmt(rpm / 1000, 1) : "—", unit: "×1000", frac: rpm === null ? null : rpm / maxRpm, color: rpm !== null && rpm > maxRpm * 0.75 ? "orange" : "lime", red: 0.8, id: r.rpm, short: "Tours",
            scale: Array.from({ length: Math.round(maxRpm / 1000) + 1 }, (_, i) => i) }),
          dialHtml(this, { label: "Liquide", value: cool !== null ? fmt(cool) : "—", unit: "°C", frac: cool === null ? null : (cool - 40) / 90, color: temp(cool, 105), red: 65 / 90, id: r.coolant, short: "Eau", scale: [40, 70, 100, 130] }),
          oil !== null ? dialHtml(this, { label: "Huile", value: fmt(oil), unit: "°C", frac: (oil - 40) / 110, color: temp(oil, 130), red: 90 / 110, id: r.oil, scale: [40, 95, 150] }) : "",
          boost !== null ? dialHtml(this, { label: "Turbo", value: fmt(boost), unit: "mbar", frac: boost / 2500, color: "blue", id: r.boost, scale: [0, 0.5, 1, 1.5, 2, 2.5] })
            : n(r.fuel) !== null ? dialHtml(this, { label: "Carburant", value: fmt(n(r.fuel)), unit: "%", frac: n(r.fuel) / 100, color: n(r.fuel) < 15 ? "red" : "blue", id: r.fuel, short: "Carbu", scale: [0, 25, 50, 75, 100] })
              : n(r.l100) !== null ? dialHtml(this, { label: "Consommation", value: fmt(n(r.l100), 1), unit: "L/100", frac: n(r.l100) / 20, color: n(r.l100) > 12 ? "orange" : "green", id: r.l100, short: "Conso", scale: [0, 5, 10, 15, 20] }) : "",
        ].filter(Boolean).join("");
        main = `<div class="vd-dash">${dialHtml(this, { label: gear !== null ? `Rapport ${gear ? fmt(gear) : "N"}` : "Vitesse", value: spd !== null ? fmt(spd) : "—", unit: "km/h", frac: spd === null ? null : spd / maxSpeed, color: "blue", big: true, ticks: 10, needle: true, id: r.speed || r.gps_speed,
          scale: Array.from({ length: 11 }, (_, i) => Math.round((maxSpeed * i) / 10)) })}<div class="vd-side">${side}</div></div>`;
      } else {
        // valeurs du trajet : Torque les remet à zéro en se reconnectant sans rouler, les zéros sont masqués
        // durée en secondes d'après l'unité du capteur (Home Assistant peut l'afficher en min ou h) ;
        // la plus longue des deux : le temps « en mouvement » repart parfois de zéro en cours de trajet
        const secs = (id) => { const x = pos(id); if (x === null) return null; const u = String(st[id]?.attributes?.unit_of_measurement || "s").toLowerCase(); return u.startsWith("h") ? x * 3600 : u.startsWith("min") ? x * 60 : u === "ms" ? x / 1000 : x; };
        const durs = [secs(r.trip_moving), secs(r.trip_time)].filter((x) => x !== null);
        const mov = durs.length ? Math.max(...durs) : null;
        const km = pos(r.trip_km);
        const trip = `${k("Dernier trajet", km !== null ? fmt(km, 1) : null, "km", r.trip_km)}${k("Durée", mov !== null ? (mov < 60 ? "< 1 min" : hm(mov / 60)) : null, "", r.trip_time || r.trip_moving)}` +
          `${k("Vitesse moy.", pos(r.trip_avg) !== null ? fmt(pos(r.trip_avg)) : null, "km/h", r.trip_avg)}${km !== null && pos(r.trip_l100) !== null ? k("Consommation", fmt(pos(r.trip_l100), 1), "L/100", r.trip_l100) : ""}`;
        const avg = pos(r.trip_avg), tl = km !== null ? pos(r.trip_l100) : null;
        if (c.theme === "obd" && trip) {
          // thème obd : le dernier trajet en cadrans ; échelle choisie selon la valeur
          const top = (x, steps) => steps.find((m) => x <= m) ?? steps[steps.length - 1];
          const sc = (m, n = 5) => Array.from({ length: n + 1 }, (_, i) => Math.round((m * i) / n));
          const kmMax = km !== null ? top(km, [10, 25, 50, 100, 250, 500, 1000]) : 10;
          const minMax = mov !== null ? top(mov / 60, [15, 30, 60, 120, 240, 480]) : 15;
          const dAvg = (big) => dialHtml(this, { label: "Vitesse moyenne", short: "Moyenne", value: avg !== null ? fmt(avg) : "—", unit: "km/h", frac: avg === null ? null : avg / 150, id: r.trip_avg, big, ticks: big ? 10 : 0, scale: [0, 30, 60, 90, 120, 150] });
          const side = [
            km !== null ? dialHtml(this, { label: "Dernier trajet", short: "Trajet", value: fmt(km, 1), unit: "km", frac: km / kmMax, id: r.trip_km, scale: sc(kmMax) }) : "",
            mov !== null ? dialHtml(this, { label: "Durée", short: "Durée", value: mov < 60 ? "< 1" : fmt(mov / 60), unit: "min", frac: mov / 60 / minMax, id: r.trip_time || r.trip_moving, scale: sc(minMax, 4) }) : "",
            tl !== null && avg !== null ? dAvg(false) : "",
          ].filter(Boolean).join("");
          const big = tl !== null
            ? dialHtml(this, { label: "Consommation du trajet", short: "Conso", value: fmt(tl, 1), unit: "L/100", frac: tl / 20, id: r.trip_l100, big: true, ticks: 10, scale: [0, 4, 8, 12, 16, 20] })
            : avg !== null ? dAvg(true) : "";
          main = big ? `<div class="vd-dash${side ? "" : " solo"}">${big}${side ? `<div class="vd-side">${side}</div>` : ""}</div>` : `<div class="vd-trip">${trip}</div>`;
        } else {
          main = trip ? `<div class="vd-trip">${trip}</div>` : `<div class="vd-none">Aucun trajet en mémoire : il s'affichera après le prochain parcours.</div>`;
        }
      }
      const bat = c.show_battery !== false ? n(r.battery) : null;
      const pills = [
        milKm ? pillHtml(this, "mdi:engine-outline", `Voyant moteur · ${fmt(milKm)} km`, r.mil_km, "alert") : "",
        bat !== null ? pillHtml(this, "mdi:car-battery", `${fmt(bat, 2)} V`, r.battery, bat < 12 ? "alert" : bat < 12.3 ? "warn" : "")
          : c.show_battery !== false && r.battery ? pillHtml(this, "mdi:car-battery-off", "Batterie hors de portée", r.battery, "off") : "",
        !live && n(r.fuel) !== null ? pillHtml(this, "mdi:gas-station", `${fmt(n(r.fuel))} %`, r.fuel, n(r.fuel) < 15 ? "warn" : "")
          : n(r.tank) !== null ? pillHtml(this, "mdi:gas-station", `${fmt(n(r.tank))} ${esc(st[r.tank].attributes.unit_of_measurement || "")}`, r.tank) : "",
        !live && oil !== null ? pillHtml(this, "mdi:oil-temperature", `Huile ${fmt(oil)} °C`, r.oil) : "",
        !live && pos(r.l100_long) !== null ? pillHtml(this, "mdi:chart-line", `Moyenne ${fmt(n(r.l100_long), 1)} L/100`, r.l100_long) : "",
        n(r.odometer) !== null ? pillHtml(this, "mdi:counter", `${fmt(n(r.odometer))} km`, r.odometer, "odo") : "",
      ].filter(Boolean).join("");
      const isOpen = open === d.id;
      let detail = "";
      if (isOpen) {
        const strip = new RegExp(`^${d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
        const rows = d.all.map((id) => {
          const o = st[id];
          const v = val(id);
          if (v === null) return null;
          const u = o.attributes.unit_of_measurement || "";
          const x = num(v);
          return [String(o.attributes.friendly_name || id).replace(strip, ""), x !== null ? `${fmt(x, Math.abs(x) < 10 && x % 1 ? 2 : Math.abs(x) < 100 && x % 1 ? 1 : 0)}${u ? ` ${u}` : ""}` : v, id];
        }).filter(Boolean).sort((a, b) => a[0].localeCompare(b[0], "fr"));
        detail = `<div class="tel-d">${rows.map(([l, v, id]) => `<div class="tel-r"${this._click({ action: "more-info", entity: id }, null, l)}><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join("")}</div>`;
      }
      const stCls = milKm ? "alert" : live ? "live" : "ok";
      const head = carHead(live ? "mdi:car-sports" : "mdi:car", esc(d.name), esc(sub || "Pas encore de trajet"), milKm ? "Voyant" : live ? "En route" : "Garée", stCls,
        `<ha-icon class="vd-more" icon="${isOpen ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>`)
        .replace('<div class="vd-h">', `<div class="vd-h"${this._click({ action: "ui", set: { car: isOpen ? null : d.id } }, { action: "more-info", entity: r.connected || r.tracker }, d.name)}>`);
      return `<div class="vd-car${isOpen ? " open" : ""}${milKm ? " alert" : live ? " live" : ""}">${head}${main}${pills ? `<div class="vd-pills">${pills}</div>` : ""}${detail}</div>`;
    }).join("");
    const sum = [driving ? `<span class="vd-st live"><i></i>${driving} en route</span>` : "", mil ? `<span class="vd-st alert"><i></i>${mil} voyant moteur</span>` : ""].join("");
    return `<div class="vd"><div class="vd-top"><ha-icon icon="${esc(c.icon || "mdi:car-multiple")}"></ha-icon><div class="vd-t"><div class="vd-ttl">${tpl(c.title ?? "Voitures", hass)}</div>` +
      `<div class="vd-sub">${list.length} véhicule${list.length > 1 ? "s" : ""} · Torque OBD-II</div></div>${sum ? `<div class="vd-sum">${sum}</div>` : ""}</div>` +
      `<div class="vd-cars">${cars}</div></div>`;
  }

  getCardSize() { return 5; }
}
MaisonTorqueCard.STYLE = TEL_STYLE + `<style>${DASH_STYLE}
.tel-d { border-top: 1px solid var(--m-line); }
.tel-r span { color: var(--m-text); }
.tel-r b { color: var(--m-muted); font-weight: 500; }
</style>`;

/* ================================================================ éditeurs */

const E = (name, domain, extra = {}) => ({ name, selector: { entity: { ...(domain ? { domain } : {}), ...extra } } });
const T = (name) => ({ name, selector: { text: {} } });
const B = (name) => ({ name, selector: { boolean: {} } });
const N = (name, min, max, step = 1) => ({ name, selector: { number: { min, max, step, mode: "box" } } });
const I = (name) => ({ name, selector: { icon: {} } });
const S = (name, options) => ({ name, selector: { select: { mode: "dropdown", options } } });
const allStrings = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));

const LABELS = {
  theme: "Thème", name: "Nom", title: "Titre", style: "Style", tile: "Style des tuiles", show_date: "Afficher la date", icon: "Icône", entity: "Entité", entities: "Entités", columns: "Colonnes (vide = automatique)",
  wrap: "Pastilles sur plusieurs lignes", align: "Alignement", area: "Pièce", temperature: "Température", humidity: "Humidité",
  media_player: "Lecteur multimédia", path: "Lien au clic (ex. #salon)", corner: "Coin carré", graph: "Courbe de température 24 h",
  height: "Hauteur (px)", row_height: "Hauteur d'une pièce (px)", slider: "Curseur de position", select: "Sélecteur de groupe (input_select)",
  code: "Code de l'alarme (sinon clavier)", modes: "Modes affichés", info: "Info à côté du nom (modèle {…})", subtitle: "Sous-titre",
  alert: "Alerte (input_boolean, ex. vider le bac)", alert_text: "Texte de l'alerte", battery: "Batterie", range: "Autonomie",
  odometer: "Kilométrage", charging: "En charge", plugged: "Branchée", charger_power: "Puissance de charge", climate: "Climatisation",
  lock: "Verrouillage", location: "Position", prefix: "Préfixe des entités (si non détectées)", progress: "Progression",
  remaining: "Temps restant", stage: "État", nozzle: "Buse", bed: "Plateau", camera: "Caméra", pause: "Bouton pause", resume: "Bouton reprise",
  stop: "Bouton arrêt", camera_view: "Caméra", day_entity: "Jour choisi (input_select, facultatif)", todo: "Liste de courses",
  first_day: "Premier jour de la semaine", short_days: "Jours abrégés", forecast_type: "Prévisions", days: "Jours",
  show_graph: "Courbe 24 h", max: "Nombre maximum", min: "Minimum", unit: "Unité", decimals: "Décimales", secondary: "Valeurs secondaires",
  position: "Position", hash: "Lien d'ouverture (#…)", width_desktop: "Largeur sur ordinateur (ex. 70%)", auto_close: "Fermeture automatique (ms)",
  show_camera: "Afficher la caméra", file: "Fichier en cours",
  devices: "Appareils (vide = tous)", low: "Batterie faible à partir de (%)", show_location: "Afficher la zone (maison, absent…)",
  stale_hours: "Appareil muet (gris) sans nouvelles depuis (heures, 0 = jamais)",
  volt_warn: "Tension basse (orange) sous (V)", volt_alert: "Tension critique (rouge) sous (V)", hours: "Durée de la courbe de tension (heures)",
  show_curve: "Courbe de tension",
  show_battery: "Tension de la batterie BM6 du même nom",
};

const EDITORS = {
  "voiture-electrique-card": [() => [T("name"), I("icon"), E("battery", "sensor"), E("range", "sensor"), E("odometer", "sensor"), E("charging"), E("plugged", "binary_sensor"),
    E("charger_power", "sensor"), E("climate", "climate"), E("lock", "lock"), E("location", "device_tracker"), T("prefix"), THEME_SELECT],
    "Tesla (Fleet, Teslemetry, Tessie, Tesla custom) est détectée seule. Pour une autre voiture électrique ou hybride rechargeable, choisissez au moins la batterie."],
  "voiture-thermique-card": [() => [T("title"), I("icon"), { name: "devices", selector: { device: { integration: "torque_obd", multiple: true } } }, B("show_location"), B("show_battery"), THEME_SELECT],
    "Les véhicules de l'intégration Torque OBD-II sont trouvés seuls, même si leurs capteurs ont été renommés. En route : vitesse, régime, température et consommation ; à l'arrêt : le dernier trajet. Un clic sur une voiture liste tous ses capteurs."],
  "voiture-batteries-card": [() => [T("title"), I("icon"), { name: "devices", selector: { device: { integration: "bm6", multiple: true } } }, N("volt_warn", 10, 14, 0.1), N("volt_alert", 10, 14, 0.1),
    N("hours", 6, 168), B("show_curve"), N("stale_hours", 0, 720), THEME_SELECT],
    "Les boîtiers BM6 (intégration Battery Monitor BM6) sont trouvés seuls. Au-dessus de 13,2 V, le moteur tourne ou la batterie est en charge. Un clic sur une batterie affiche son détail."],
};

/* ============================================================ enregistrement */

const CARDS = [
  ["voiture-electrique-card", MaisonVoitureCard, "Voitures · Voiture électrique ou hybride", "Batterie, autonomie, kilométrage, charge, climatisation et verrouillage.", () => ({ name: "Voiture" }), "maison-voiture-card"],
  ["voiture-thermique-card", MaisonTorqueCard, "Voitures · Voitures (Torque OBD-II)", "Voitures suivies par Torque Pro : en route, dernier trajet, consommation, voyant moteur et batterie.", () => ({}), "maison-torque-card"],
  ["voiture-batteries-card", MaisonBatteriesCard, "Voitures · Batteries 12 V (BM6)", "Tension, charge, état, température et courbe des batteries 12 V suivies par des boîtiers BM6.", () => ({}), "maison-batteries-card"],
];

if (typeof customElements !== "undefined") {
  const define = (name, cls) => { if (!customElements.get(name)) customElements.define(name, cls); };
  window.customCards = window.customCards || [];
  for (const [type, cls, name, description, stub, legacy] of CARDS) {
    const [schemaFn, helper] = EDITORS[type];
    const Ed = makeEditor(schemaFn, LABELS, cls.DEFAULTS || {}, helper);
    cls.getConfigElement = () => document.createElement(`${type}-editor`);
    cls.getStubConfig = (hass) => stub(hass);
    define(type, cls);
    define(`${type}-editor`, Ed);
    // ancien nom des Cartes Maison HA : les tableaux de bord existants continuent de fonctionner
    define(legacy, class extends cls {});
    if (!window.customCards.some((c) => c.type === type)) window.customCards.push({ type, name, description, preview: true });
  }
  console.info(`%c VOITURES-CARDS %c ${CARD_VERSION} `, "background:#6ee52e;color:#0b1a05;font-weight:700", "background:#2b2c2f;color:#fff");
}
})();
