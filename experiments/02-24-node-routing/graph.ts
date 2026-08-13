export interface NodeSpec {
  id: string;
  profile: string;
}

export interface QuestionSpec {
  requestId: string;
  origin: string;
  holder: string;
  question: string;
  answer: string;
  idealRoute: readonly [string, string, string];
}

export const nodes: readonly NodeSpec[] = [
  { id: "astro-ephemeris", profile: "celestial timing and orbital tables" },
  { id: "astro-optics", profile: "lenses, mirrors, and optical coatings" },
  { id: "astro-ops", profile: "observing schedules and night operations" },
  { id: "astro-weather", profile: "sky conditions and atmospheric logs" },
  { id: "astro-spectra", profile: "spectral records and observatory archives" },
  { id: "astro-instruments", profile: "instrument hardware and calibration" },
  { id: "bio-plants", profile: "plants, herbarium records, and phenology" },
  { id: "bio-soils", profile: "soil samples, minerals, and geochemistry" },
  { id: "bio-pollinators", profile: "pollinators, moths, bees, and insects" },
  { id: "bio-water", profile: "watersheds, streams, and hydrology" },
  { id: "bio-conservation", profile: "wildlife and conservation records" },
  { id: "bio-field", profile: "field expeditions, equipment, and logistics" },
  { id: "civic-transit", profile: "routes, stations, shuttles, and transit" },
  { id: "civic-maps", profile: "maps, sites, addresses, and GIS" },
  { id: "civic-grid", profile: "power grid, substations, and electrical faults" },
  { id: "civic-procurement", profile: "purchases, vendors, and supply contracts" },
  { id: "civic-incidents", profile: "incident reports and witness records" },
  { id: "civic-permits", profile: "permits, inspections, and approvals" },
  { id: "heritage-oral", profile: "oral histories, interviews, and witnesses" },
  { id: "heritage-catalog", profile: "museum catalogs and collection records" },
  { id: "heritage-language", profile: "historical language and translation" },
  { id: "heritage-acoustics", profile: "sound archives and acoustic analysis" },
  { id: "heritage-preservation", profile: "preservation and conservation methods" },
  { id: "heritage-provenance", profile: "ownership, origin, and provenance" },
];

export const edges: ReadonlyArray<readonly [string, string]> = [
  ["astro-ephemeris", "astro-optics"],
  ["astro-optics", "astro-ops"],
  ["astro-ops", "astro-weather"],
  ["astro-weather", "astro-spectra"],
  ["astro-spectra", "astro-instruments"],
  ["astro-instruments", "astro-ephemeris"],
  ["astro-ephemeris", "astro-weather"],
  ["astro-optics", "astro-spectra"],
  ["bio-plants", "bio-soils"],
  ["bio-soils", "bio-pollinators"],
  ["bio-pollinators", "bio-water"],
  ["bio-water", "bio-conservation"],
  ["bio-conservation", "bio-field"],
  ["bio-field", "bio-plants"],
  ["bio-plants", "bio-pollinators"],
  ["bio-soils", "bio-conservation"],
  ["civic-transit", "civic-maps"],
  ["civic-maps", "civic-grid"],
  ["civic-grid", "civic-procurement"],
  ["civic-procurement", "civic-incidents"],
  ["civic-incidents", "civic-permits"],
  ["civic-permits", "civic-transit"],
  ["civic-transit", "civic-grid"],
  ["civic-maps", "civic-incidents"],
  ["civic-incidents", "heritage-oral"],
  ["heritage-oral", "heritage-catalog"],
  ["heritage-catalog", "heritage-language"],
  ["heritage-language", "heritage-acoustics"],
  ["heritage-acoustics", "heritage-preservation"],
  ["heritage-preservation", "heritage-provenance"],
  ["heritage-provenance", "heritage-oral"],
  ["heritage-oral", "heritage-acoustics"],
  ["heritage-catalog", "heritage-preservation"],
  ["astro-ops", "civic-transit"],
  ["astro-weather", "bio-water"],
  ["astro-spectra", "heritage-catalog"],
  ["astro-optics", "heritage-acoustics"],
  ["bio-plants", "heritage-preservation"],
  ["bio-soils", "civic-procurement"],
  ["bio-water", "civic-maps"],
  ["bio-conservation", "heritage-oral"],
  ["civic-grid", "heritage-acoustics"],
  ["civic-permits", "heritage-provenance"],
];

export const questions: readonly QuestionSpec[] = [
  {
    requestId: "route-01",
    origin: "astro-instruments",
    holder: "astro-weather",
    question:
      "In the fictional Nacre Hollow instrument-safety log, at what local sidereal time did the wind halt occur?",
    answer: "04:17 LST",
    idealRoute: ["astro-instruments", "astro-ephemeris", "astro-weather"],
  },
  {
    requestId: "route-02",
    origin: "astro-optics",
    holder: "civic-grid",
    question:
      "In the fictional Meridian Grid incident Rook-12, what acoustic relay signature was logged?",
    answer: "Glass Harbor",
    idealRoute: ["astro-optics", "heritage-acoustics", "civic-grid"],
  },
  {
    requestId: "route-03",
    origin: "astro-ops",
    holder: "civic-maps",
    question:
      "On the fictional Northglass dawn-shuttle platform map, what marker labels the observatory crew stop?",
    answer: "Amber Triangle",
    idealRoute: ["astro-ops", "civic-transit", "civic-maps"],
  },
  {
    requestId: "route-04",
    origin: "astro-spectra",
    holder: "heritage-language",
    question:
      "For the fictional Orison Museum spectrum plate 88-K, what old-language gloss is recorded in the collection catalog?",
    answer: "Silver Orchard",
    idealRoute: ["astro-spectra", "heritage-catalog", "heritage-language"],
  },
  {
    requestId: "route-05",
    origin: "civic-procurement",
    holder: "bio-pollinators",
    question:
      "For the fictional clay nesting inserts bought under Alder batch 31, what moth-ledger code was assigned?",
    answer: "Mallow-47",
    idealRoute: ["civic-procurement", "bio-soils", "bio-pollinators"],
  },
  {
    requestId: "route-06",
    origin: "bio-water",
    holder: "bio-field",
    question:
      "In the fictional Reedbank watershed conservation expedition, what code identified the field-equipment cache?",
    answer: "Kestrel Nine",
    idealRoute: ["bio-water", "bio-conservation", "bio-field"],
  },
  {
    requestId: "route-07",
    origin: "bio-plants",
    holder: "heritage-provenance",
    question:
      "What provenance seal appears on the fictional preserved Lumen herbarium sheet?",
    answer: "Violet Anvil",
    idealRoute: ["bio-plants", "heritage-preservation", "heritage-provenance"],
  },
  {
    requestId: "route-08",
    origin: "civic-permits",
    holder: "heritage-oral",
    question:
      "In the fictional Bellweather permit incident, what phrase did the archived witness interview use?",
    answer: "River Without Bells",
    idealRoute: ["civic-permits", "civic-incidents", "heritage-oral"],
  },
];

export function peersFor(nodeId: string): string[] {
  const peers: string[] = [];
  for (const [left, right] of edges) {
    if (left === nodeId) {
      peers.push(right);
    } else if (right === nodeId) {
      peers.push(left);
    }
  }
  return peers;
}

export function profileFor(nodeId: string): string {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  return node.profile;
}
