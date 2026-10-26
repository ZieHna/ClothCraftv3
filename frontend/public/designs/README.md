# Premade designs

The files here are made by `frontend/scripts/make-premade-designs.mjs`; do not edit them by hand.

| folder | what it holds |
|---|---|
| `templates/<id>.json` | one design as a snapshot of the Simple editor (its own format, `src/editor/types.ts`): every layer is an editable text, shape or picture layer, drawn in a 600-unit frame centred at (400, 400) |
| `assets/<id>-<asset>.png` | the picture layers a design uses (only Mountain Mist, Wild Fern and Tropical Leaf have one) |
| `previews/<id>.webp` | the design on a garment, drawn by the editor itself on the shop's own garment photos (`public/garments/`) |
| `previews/<id>--<product>.webp` | the mockup of a design on one featured product (used only in the landing page's Featured section) |

The list of designs, their styles, garments and featured products is `src/designs/catalog.ts` (the one source of truth). The artwork (text, shapes and the three
SVG illustrations) is `scripts/premade/designs.mjs`.

## Where the artwork comes from

**It is original work drawn for ClothCraft in code, not AI-generated and not copied from anywhere.** No image-generation tool was used. The words are set in the
editor's five fonts (all SIL OFL, see `src/editor/fonts.ts`), the shapes are the editor's own, and the three illustrations (mountains, fern, leaf) are SVG
drawings written for this project and saved as PNG picture layers. The Filipino-inspired designs use common motifs (an eight-rayed sun, a woven lattice, a Filipino
phrase); none copies a flag, a logo or a brand. The garments in the previews are the shop's existing garment photos, whose source and licence are still
unconfirmed (see `public/garments/CREDITS.md`).

## How the designs reach the editor

`/design?template=<id>` (optionally with `&product=` and `&variant=`) loads the template into the existing editor as a COPY: `src/designs/template.ts` fits the frame into
the chosen garment's print box and hands the editor a snapshot. These files are static and read-only; nothing a customer does is written back to them.

## To change or add a design

1. Draw it in `scripts/premade/designs.mjs` and add its entry to `src/designs/catalog.ts`.
2. Start the dev server (`npm run dev`) and run `node scripts/make-premade-designs.mjs` (needs Microsoft Edge). Pass design ids to remake only those.
3. Run the tests: `npx vitest run --project jsdom src/designs` checks that every design has its files and that `editable` tells the truth.
