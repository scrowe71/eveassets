// Pure helpers (no DOM, no network) so they can be tested in Node.

export const OFFICE_TYPE_ID = 27;
const CORP_SAG = /^CorpSAG(\d)$/;

const FLAG_LABELS = {
  Hangar: 'Hangar', HangarAll: 'Hangar', Cargo: 'Cargo', DroneBay: 'Drone bay',
  FighterBay: 'Fighter bay', FighterTube0: 'Fighter tube', ShipHangar: 'Ship hangar',
  FleetHangar: 'Fleet hangar', CorpDeliveries: 'Deliveries', Deliveries: 'Deliveries',
  AssetSafety: 'Asset safety', Unlocked: 'In container', Locked: 'In container (locked)',
  AutoFit: 'In container', Implant: 'Implant', Skill: 'Skill', Wardrobe: 'Wardrobe',
  OfficeFolder: 'Office', Impounded: 'Impounded', InfrastructureHangar: 'Infrastructure hangar',
  MoonMaterialBay: 'Moon material bay', StructureFuel: 'Fuel bay', QuafeBay: 'Quafe bay',
  FrigateEscapeBay: 'Frigate escape bay', CorporationGoalDeliveries: 'Project deliveries',
};

export function humanFlag(flag) {
  if (!flag) return '';
  if (/^(Hi|Med|Lo|Rig|SubSystem|Service)Slot\d+$/.test(flag)) return 'Fitted';
  if (CORP_SAG.test(flag)) return '';            // shown in the Division column instead
  if (FLAG_LABELS[flag]) return FLAG_LABELS[flag];
  return flag.replace(/^Specialized/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Walk an asset up through its containers. Returns the top-level asset in the list. */
function walk(asset, byId, visit) {
  let cur = asset;
  let guard = 0;
  while (byId.has(cur.location_id) && guard++ < 25) {
    const parent = byId.get(cur.location_id);
    if (parent === cur) break;
    visit?.(parent);
    cur = parent;
  }
  return cur;
}

/** Top-level location ids (stations, structures, systems) for a list of assets. */
export function rootLocations(assets) {
  const byId = new Map(assets.map(a => [a.item_id, a]));
  const out = new Set();
  for (const a of assets) out.add(walk(a, byId).location_id);
  return [...out];
}

/**
 * Turn an owner snapshot into display rows.
 * snapshot: { ownerKey, ownerName, kind, assets, itemNames, divisions }
 * ctx: { typeName(id), locationName(id), unitPrice(typeId, isBpc) }
 */
export function buildRows(snapshot, ctx) {
  const assets = snapshot.assets || [];
  const byId = new Map(assets.map(a => [a.item_id, a]));
  const itemNames = snapshot.itemNames || {};
  const divisions = snapshot.divisions || {};
  const rows = [];

  for (const a of assets) {
    if (a.type_id === OFFICE_TYPE_ID) continue;   // office wrappers are bookkeeping, not items

    const chain = [];
    let divFlag = CORP_SAG.test(a.location_flag) ? a.location_flag : null;
    const top = walk(a, byId, parent => {
      if (parent.type_id !== OFFICE_TYPE_ID) {
        chain.unshift(itemNames[parent.item_id] || ctx.typeName(parent.type_id));
      }
      if (CORP_SAG.test(parent.location_flag)) divFlag = parent.location_flag;
    });

    let division = '';
    if (divFlag) {
      const n = Number(divFlag.match(CORP_SAG)[1]);
      division = divisions[n] || `Division ${n}`;
    }

    const isBpc = !!a.is_blueprint_copy;
    const qty = a.quantity ?? 1;
    const unit = ctx.unitPrice(a.type_id, isBpc);
    const name = ctx.typeName(a.type_id);
    rows.push({
      ownerKey: snapshot.ownerKey,
      owner: snapshot.ownerName,
      itemId: a.item_id,
      typeId: a.type_id,
      name,
      customName: itemNames[a.item_id] || '',
      qty,
      isBpc,
      locationId: top.location_id,
      location: ctx.locationName(top.location_id),
      container: chain.join(' › '),
      slot: humanFlag(a.location_flag),
      division,
      unit,
      value: unit * qty,
      search: `${name} ${itemNames[a.item_id] || ''} ${chain.join(' ')}`.toLowerCase(),
    });
  }
  return rows;
}

export function filterRows(rows, { q = '', location = '', division = '', region = '', constellation = '', system = '' } = {}) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(r =>
    (!region || String(r.regionId) === region) &&
    (!constellation || String(r.constellationId) === constellation) &&
    (!system || String(r.systemId) === system) &&
    (!location || String(r.locationId) === location) &&
    (!division || r.division === division) &&
    terms.every(t => r.search.includes(t) || r.location.toLowerCase().includes(t) || (r.geoSearch || '').includes(t)));
}

export function sortRows(rows, { key = 'value', dir = -1 } = {}) {
  const get = {
    name: r => r.name.toLowerCase(), qty: r => r.qty, value: r => r.value, unit: r => r.unit,
    owner: r => r.owner.toLowerCase(), location: r => r.location.toLowerCase(),
    locations: r => r.locations ?? 0,
  }[key] || (r => r.value);
  return [...rows].sort((a, b) => {
    const x = get(a), y = get(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

export function groupByLocation(rows) {
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.locationId);
    if (!g) groups.set(r.locationId, g = { id: r.locationId, name: r.location, rows: [], value: 0 });
    g.rows.push(r);
    g.value += r.value;
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

/** Group rows by any id/name pair, e.g. ('systemId', 'system'). */
export function groupByKey(rows, idKey, nameKey) {
  const groups = new Map();
  for (const r of rows) {
    const id = r[idKey];
    let g = groups.get(id);
    if (!g) groups.set(id, g = { id, name: r[nameKey], first: r, rows: [], value: 0 });
    g.rows.push(r);
    g.value += r.value;
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
}

/** EVE's displayed security: rounded to 1 decimal, but anything just above 0.0 shows as 0.1. */
export function displaySec(sec) {
  if (sec == null) return '';
  if (sec > 0 && sec < 0.05) return '0.1';
  return (Math.round(sec * 10) / 10).toFixed(1);
}

export function groupByType(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = `${r.typeId}:${r.isBpc ? 1 : 0}`;
    let g = map.get(k);
    if (!g) map.set(k, g = { typeId: r.typeId, name: r.name, isBpc: r.isBpc, qty: 0, value: 0, unit: r.unit, locSet: new Set(), ownerSet: new Set() });
    g.qty += r.qty;
    g.value += r.value;
    g.locSet.add(r.locationId);
    g.ownerSet.add(r.owner);
  }
  return [...map.values()].map(g => ({ ...g, locations: g.locSet.size, owner: [...g.ownerSet].join(', ') }));
}

const CSV_COLS = [
  ['Owner', 'owner'], ['Location', 'location'], ['Division', 'division'], ['Container', 'container'],
  ['Slot', 'slot'], ['Item', 'name'], ['Custom name', 'customName'], ['Type ID', 'typeId'],
  ['Quantity', 'qty'], ['BPC', r => (r.isBpc ? 'yes' : '')], ['Unit price', r => r.unit.toFixed(2)],
  ['Value', r => r.value.toFixed(2)],
];

export function toCsv(rows) {
  const cell = v => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLS.map(c => c[0]).join(',')];
  for (const r of rows) lines.push(CSV_COLS.map(([, k]) => cell(typeof k === 'function' ? k(r) : r[k])).join(','));
  return lines.join('\r\n');
}

export function formatIsk(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export const formatNum = n => Number(n).toLocaleString('en-US');

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const m = Math.round((now - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
