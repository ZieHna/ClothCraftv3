/**
 * The premade-design catalog: the ONE source of truth for the designs a customer can start from (Featured designs on the landing page, the
 * Browse all designs page, and the editor's ?template= entry all read it). It holds design-template facts only: no price, no stock and no
 * product data, which come from the shop's API. Plain data on purpose (only erasable TypeScript), so scripts/make-premade-designs.mjs can
 * read the same file when it renders the previews.
 *
 * Every design is an editor snapshot in public/designs/templates/<id>.json (the Simple editor's own format, see src/editor/types.ts) plus the
 * pictures it uses in public/designs/assets/. Opening one loads a COPY into the editor: the files are static and nothing a customer does
 * can write to them. The artwork is original: text and shapes the editor can edit, and vector illustrations (drawn for this project, see
 * scripts/premade/designs.mjs) that sit in a design as picture layers. To add a design: draw it in scripts/premade/designs.mjs, add its entry
 * here, run `node scripts/make-premade-designs.mjs`, commit the files it writes.
 */
export type DesignStyle = 'Typography' | 'Streetwear' | 'Nature' | 'Filipino-inspired' | 'Abstract';
export const DESIGN_STYLES: readonly DesignStyle[] = ['Typography', 'Streetwear', 'Nature', 'Filipino-inspired', 'Abstract'];

/** how much of a design the editor can change: "full" is only text and shape layers; "layers" also has a picture layer (move, resize and rotate it, but its drawing is one image) */
export type Editable = 'full' | 'layers';

export interface PremadeDesign {
  /** unique, lower-case, also the file name of its template and previews */
  id: string;
  name: string;
  style: DesignStyle;
  summary: string;
  /** garment type codes (the shop's own, for example TEE, HOOD) the design is made for */
  garmentTypes: readonly string[];
  featured: boolean;
  editable: Editable;
  /** the colours of garment the art reads well on (colour ids of the shop) */
  bestOn: readonly string[];
  /** the product and colour of the general preview */
  previewGarment: { product: string; color: string };
  previewAlt: string;
  /** where the design appears on a featured product: product id -> the mockup on that product. Only a mockup picture; name, price and stock stay the product's. */
  featuredOn?: Record<string, { color: string }>;
}

const TOPS = ['TEE', 'CROP', 'LSLV', 'VNECK', 'TANK', 'POLO'] as const;

export const DESIGN_CATALOG: readonly PremadeDesign[] = [
  {
    id: 'night-shift', name: 'Night Shift', style: 'Streetwear', summary: 'Tall block capitals and three gold stars: a loud one for late nights.',
    garmentTypes: ['TEE', 'LSLV', 'HOOD', 'VNECK'], featured: true, editable: 'full', bestOn: ['black', 'navy'],
    previewGarment: { product: 'm-tee', color: 'black' }, previewAlt: 'A black T-shirt printed with NIGHT in cream and SHIFT in gold block capitals, with three gold stars below',
    featuredOn: { 'm-tee': { color: 'black' } },
  },
  {
    id: 'bloom', name: 'Bloom', style: 'Abstract', summary: 'Six soft petals around a gold centre, built from simple shapes.',
    garmentTypes: [...TOPS, 'ONESIE'], featured: true, editable: 'full', bestOn: ['white', 'gray'],
    previewGarment: { product: 'w-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with a flower of six blush and terracotta petals around a gold centre and the word bloom',
    featuredOn: { 'w-crop': { color: 'white' } },
  },
  {
    id: 'quiet-hours', name: 'Quiet Hours', style: 'Typography', summary: 'Stacked capitals, a thin gold rule and a handwritten “do not disturb”.',
    garmentTypes: ['HOOD', 'TEE', 'LSLV'], featured: true, editable: 'full', bestOn: ['black', 'navy'],
    previewGarment: { product: 'w-hood', color: 'black' }, previewAlt: 'A black hoodie printed with QUIET HOURS in cream capitals, a gold line and the handwritten words do not disturb',
    featuredOn: { 'w-hood': { color: 'black' } },
  },
  {
    id: 'mountain-mist', name: 'Mountain Mist', style: 'Nature', summary: 'Layered green ridges, a low gold sun and morning mist.',
    garmentTypes: ['TEE', 'LSLV', 'VNECK', 'POLO', 'TANK'], featured: true, editable: 'layers', bestOn: ['white', 'gray'],
    previewGarment: { product: 'w-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with three layers of green mountains under a gold sun, with the words Mountain Mist',
    featuredOn: { 'w-tee': { color: 'white' } },
  },
  {
    id: 'little-sun', name: 'Little Sun', style: 'Filipino-inspired', summary: 'An eight-rayed sun in gold with the Filipino word for sun, Araw.',
    garmentTypes: [...TOPS, 'ONESIE', 'HOOD'], featured: true, editable: 'full', bestOn: ['red', 'navy', 'black'],
    previewGarment: { product: 'b-ones', color: 'red' }, previewAlt: 'A red baby onesie printed with a gold sun with eight rays and the word Araw',
    featuredOn: { 'b-ones': { color: 'red' } },
  },
  {
    id: 'slow-mornings', name: 'Slow Mornings', style: 'Typography', summary: 'An elegant serif SLOW, a handwritten “mornings” and a gold line.',
    garmentTypes: [...TOPS, 'HOOD'], featured: false, editable: 'full', bestOn: ['white', 'gray'],
    previewGarment: { product: 'm-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with the serif word SLOW, the handwritten word mornings and the words and good coffee',
  },
  {
    id: 'kape-muna', name: 'Kape Muna', style: 'Filipino-inspired', summary: 'A coffee cup and a retro script “Kape muna”: coffee first, in Filipino.',
    garmentTypes: [...TOPS, 'HOOD'], featured: false, editable: 'full', bestOn: ['white', 'gray'],
    previewGarment: { product: 'm-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with a terracotta coffee cup with steam and the script words Kape muna, coffee first',
  },
  {
    id: 'banig-weave', name: 'Banig Weave', style: 'Filipino-inspired', summary: 'A woven lattice of diamonds in the colours of a banig mat.',
    garmentTypes: [...TOPS, 'ONESIE'], featured: false, editable: 'full', bestOn: ['white', 'gray'],
    previewGarment: { product: 'w-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with a four by four woven lattice of terracotta, black, gold and green diamonds',
  },
  {
    id: 'wild-fern', name: 'Wild Fern', style: 'Nature', summary: 'A single fern frond with the handwritten words “wild & free”.',
    garmentTypes: [...TOPS, 'ONESIE', 'HOOD'], featured: false, editable: 'layers', bestOn: ['white', 'gray'],
    previewGarment: { product: 'm-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with a dark green fern frond and the handwritten words wild and free',
  },
  {
    id: 'tropical-leaf', name: 'Tropical Leaf', style: 'Nature', summary: 'A big split leaf in two greens, with “tropical state of mind”.',
    garmentTypes: [...TOPS, 'HOOD'], featured: false, editable: 'layers', bestOn: ['white', 'gray'],
    previewGarment: { product: 'w-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with a large green split leaf and the words tropical state of mind',
  },
  {
    id: 'shapes-in-motion', name: 'Shapes in Motion', style: 'Abstract', summary: 'A circle, a triangle, a square and a star, caught mid-turn.',
    garmentTypes: [...TOPS, 'HOOD'], featured: false, editable: 'full', bestOn: ['white', 'gray', 'black'],
    previewGarment: { product: 'm-tee', color: 'white' }, previewAlt: 'A white T-shirt printed with an overlapping gold circle, terracotta triangle, black square and green star',
  },
  {
    id: 'weekend-club', name: 'Weekend Club', style: 'Streetwear', summary: 'A gold badge, big capitals and “members only, no rules”.',
    garmentTypes: ['HOOD', 'TEE', 'LSLV'], featured: false, editable: 'full', bestOn: ['black', 'navy'],
    previewGarment: { product: 'w-hood', color: 'navy' }, previewAlt: 'A navy hoodie printed with a gold round badge reading WEEKEND CLUB in capitals and the words members only no rules',
  },
];

// ---------------------------------------------------------------------------------------------------------------- lookups and the file names
const byId = new Map(DESIGN_CATALOG.map((d) => [d.id, d]));
export const getDesign = (id: string | null | undefined): PremadeDesign | undefined => (id ? byId.get(id) : undefined);
export const featuredDesigns = (): PremadeDesign[] => DESIGN_CATALOG.filter((d) => d.featured);
export const designsInStyle = (style: DesignStyle | 'all'): PremadeDesign[] => (style === 'all' ? [...DESIGN_CATALOG] : DESIGN_CATALOG.filter((d) => d.style === style));
/** the styles that really have a design, in the catalog's own order (a filter is never offered for an empty style) */
export const stylesInUse = (): DesignStyle[] => DESIGN_STYLES.filter((s) => DESIGN_CATALOG.some((d) => d.style === s));
export const fitsGarment = (design: PremadeDesign, garmentTypeCode: string) => design.garmentTypes.includes(garmentTypeCode);

export const templateUrl = (id: string) => `/designs/templates/${id}.json`;
export const previewUrl = (id: string) => `/designs/previews/${id}.webp`;
export const featuredPreviewUrl = (id: string, productId: string) => `/designs/previews/${id}--${productId}.webp`;
/** the featured design that has a mockup on this product, if any (a product the catalog does not mention keeps its own picture) */
export const featuredDesignFor = (productId: string): { design: PremadeDesign; color: string; preview: string } | undefined => {
  for (const d of DESIGN_CATALOG) {
    const on = d.featuredOn?.[productId];
    if (on) return { design: d, color: on.color, preview: featuredPreviewUrl(d.id, productId) };
  }
  return undefined;
};

// ---------------------------------------------------------------------------------------------------------------- wording and links
/** the shop's garment type codes in plain words (what a design is made for); a code the table does not know is shown as it is */
export const GARMENT_LABEL: Readonly<Record<string, string>> = {
  TEE: 'T-shirts', CROP: 'cropped tees', LSLV: 'long sleeves', VNECK: 'V-neck tees', TANK: 'tank tops', POLO: 'polo shirts', HOOD: 'hoodies', ONESIE: 'onesies', JKT: 'jackets', DRESS: 'dresses',
};
export const garmentLabels = (design: PremadeDesign): string[] => design.garmentTypes.map((c) => GARMENT_LABEL[c] ?? c);
/** every garment type some design is made for, in the order of GARMENT_LABEL (a filter is never offered for a garment no design fits) */
export const garmentTypesInUse = (): string[] => Object.keys(GARMENT_LABEL).filter((c) => DESIGN_CATALOG.some((d) => d.garmentTypes.includes(c)));
/** the editor's address for a design: with no product it first asks which garment; with a product and no variant it picks a sensible colour and size */
export const customizeUrl = (designId: string, productId?: string, variantSku?: string): string => {
  const params = new URLSearchParams({ template: designId });
  if (productId) params.set('product', productId);
  if (productId && variantSku) params.set('variant', variantSku);
  return `/design?${params.toString()}`;
};
export const EDITABLE_NOTE: Readonly<Record<Editable, string>> = {
  full: 'Every part is editable: change the words, fonts, colours and shapes.',
  layers: 'The words and shapes are editable. The illustration is one picture you can move, resize and rotate, not redraw.',
};
