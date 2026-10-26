// Identity is verified by geographic proximity as well as an explicit name/alias.
export const ALIASES = {
  'wa-big-j': ['BJ'],
  'wa-black-mountain': ['Black'],
  'wa-blyn': ['Blynn'],
  'wa-chelan-butte': ['Chelan'],
  'wa-goat-peak-mazama': ['Goat_Peak'],
  'wa-inkler-s-point': ['Inkler'],
  'wa-mt-baker-summit': ['MtBaker'],
  'wa-parker-mtn': ['Parker'],
  'wa-rampart-ridge': ['Rampart'],
  'wa-sauk-mountain': ['Sauk'],
  'wa-tiger-mountain': ['Tiger'],
  'wa-tumwater-mountain': ['Tumwater'],
  'wa-steptoe-butte': ['Steptoe'],
  'wa-kiona-pg-launch': ['Kiona_PG_launch'],
  'wa-mt-si': ['MtSi'],
  'or-abert-rim-walkup': ['Abert_Rim'],
  'or-mt-bachelor': ['Mt._Bachelor'],
  'or-pine-mt': ['Pine_Mountain'],
  'or-howard': ['Mt._Howard', 'Mt_Howard_launch'],
};
export function distanceKm(a, b) {
  if (![a.latitude, a.longitude, b.latitude, b.longitude].every(Number.isFinite)) return null;
  const rad = Math.PI / 180,
    dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  return (
    12742 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(dlat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlon / 2) ** 2,
        ),
      ),
    )
  );
}
const normalized = (s) =>
  s
    .toLowerCase()
    .replace(/mountain|mount\b|\bmt\.?\b|launch/g, '')
    .replace(/[^a-z0-9]/g, '');
export function matchSites(sites, candidates) {
  return sites.map((site) => {
    const names = new Set([site.name, ...(ALIASES[site.slug] ?? [])].map(normalized));
    const nearby = candidates
      .map((c) => ({ ...c, distanceKm: distanceKm(site, c) }))
      .filter((c) => c.distanceKm !== null && c.distanceKm <= 10)
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const named = candidates.filter((c) => names.has(normalized(c.id)));
    const verified = named.filter((c) => {
      const d = distanceKm(site, c);
      return d !== null && d <= 10;
    });
    const unique = verified.length === 1 ? verified[0] : null;
    return {
      site,
      status: unique ? 'matched' : named.length || nearby.length ? 'ambiguous' : 'outside-shared-coverage',
      wxId: unique?.id ?? null,
      distanceKm: unique ? distanceKm(site, unique) : null,
      reason: unique
        ? 'name/explicit alias and coordinates within 10 km; grid offset retained'
        : 'no unique name-and-coordinate match',
      candidates: [
        ...new Map([...named, ...nearby].map((c) => [c.id, { id: c.id, distanceKm: distanceKm(site, c) }])).values(),
      ],
    };
  });
}
