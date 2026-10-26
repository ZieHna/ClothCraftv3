import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  customizeUrl, DESIGN_CATALOG, DESIGN_STYLES, designsInStyle, featuredDesignFor, featuredDesigns, featuredPreviewUrl, fitsGarment, GARMENT_LABEL, garmentLabels, garmentTypesInUse, getDesign, previewUrl,
  stylesInUse, templateUrl,
} from './catalog';
import type { TemplateFile } from './template';

const publicFile = (url: string) => resolve(process.cwd(), 'public', url.slice(1)); // vitest runs from frontend/
const template = (id: string): TemplateFile => JSON.parse(readFileSync(publicFile(templateUrl(id)), 'utf8'));

describe('the premade-design catalog', () => {
  it('has unique, URL-safe ids and a name, summary, alt text and garment for every design', () => {
    const ids = DESIGN_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of DESIGN_CATALOG) {
      expect(d.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(d.name.length).toBeGreaterThan(2);
      expect(d.summary.length).toBeGreaterThan(10);
      expect(d.previewAlt.length).toBeGreaterThan(20);
      expect(DESIGN_STYLES).toContain(d.style);
      expect(d.garmentTypes.length).toBeGreaterThan(0);
      for (const code of d.garmentTypes) expect(GARMENT_LABEL[code], `${d.id}: ${code}`).toBeTruthy();
      expect(d.bestOn.length).toBeGreaterThan(0);
    }
  });

  it('keeps design-template data apart from product data: no price, stock or SKU anywhere in an entry', () => {
    for (const d of DESIGN_CATALOG) expect(Object.keys(d).filter((k) => /price|stock|sku|status|inventory/i.test(k))).toEqual([]);
  });

  it('has the template file and the preview picture of every design, and the mockup of every featured product', () => {
    for (const d of DESIGN_CATALOG) {
      expect(existsSync(publicFile(templateUrl(d.id))), `template of ${d.id}`).toBe(true);
      expect(existsSync(publicFile(previewUrl(d.id))), `preview of ${d.id}`).toBe(true);
      for (const productId of Object.keys(d.featuredOn ?? {})) expect(existsSync(publicFile(featuredPreviewUrl(d.id, productId))), `${d.id} on ${productId}`).toBe(true);
    }
  });

  it('every template is a valid Simple-editor snapshot whose pictures exist, and "editable" tells the truth about picture layers', () => {
    for (const d of DESIGN_CATALOG) {
      const t = template(d.id);
      expect(t.engine).toBe('simple');
      expect(t.schemaVersion).toBe(1);
      expect(t.frame).toBe(600);
      expect(t.state.objects.length).toBeGreaterThan(0);
      expect(t.state.objects.length).toBeLessThanOrEqual(50); // the shop accepts at most 50 elements in a design
      for (const asset of Object.values(t.assets)) {
        expect(existsSync(publicFile(asset.file)), asset.file).toBe(true);
        expect(['image/png', 'image/jpeg', 'image/webp']).toContain(asset.type);
      }
      const hasPicture = t.state.objects.some((o) => o.layerType === 'image');
      expect(d.editable, d.id).toBe(hasPicture ? 'layers' : 'full');
      expect(Object.keys(t.assets).length > 0, d.id).toBe(hasPicture);
    }
  });

  it('every layer of every template sits inside the 600-unit frame', () => {
    for (const d of DESIGN_CATALOG) {
      for (const o of template(d.id).state.objects) {
        const { left, top, width, height, scaleX, scaleY } = o as Record<string, number>;
        const halfW = (width * scaleX) / 2;
        const halfH = (height * scaleY) / 2;
        expect(left - halfW, `${d.id} ${String(o.layerName)} left`).toBeGreaterThanOrEqual(95);
        expect(left + halfW, `${d.id} ${String(o.layerName)} right`).toBeLessThanOrEqual(705);
        expect(top - halfH, `${d.id} ${String(o.layerName)} top`).toBeGreaterThanOrEqual(95);
        expect(top + halfH, `${d.id} ${String(o.layerName)} bottom`).toBeLessThanOrEqual(705);
      }
    }
  });

  it('looks designs up, filters by style and only offers styles and garments that have a design', () => {
    expect(getDesign('night-shift')?.name).toBe('Night Shift');
    expect(getDesign('nope')).toBeUndefined();
    expect(getDesign(null)).toBeUndefined();
    expect(featuredDesigns().every((d) => d.featured)).toBe(true);
    expect(featuredDesigns().length).toBeGreaterThanOrEqual(5);
    expect(designsInStyle('all')).toHaveLength(DESIGN_CATALOG.length);
    expect(designsInStyle('Nature').every((d) => d.style === 'Nature')).toBe(true);
    expect(stylesInUse().every((s) => DESIGN_CATALOG.some((d) => d.style === s))).toBe(true);
    expect(garmentTypesInUse().every((c) => DESIGN_CATALOG.some((d) => d.garmentTypes.includes(c)))).toBe(true);
    expect(fitsGarment(getDesign('quiet-hours')!, 'HOOD')).toBe(true);
    expect(fitsGarment(getDesign('quiet-hours')!, 'ONESIE')).toBe(false);
    expect(garmentLabels(getDesign('quiet-hours')!)).toEqual(['hoodies', 'T-shirts', 'long sleeves']);
  });

  it('finds the design mockup of a featured product, and nothing for a product the catalog does not mention', () => {
    expect(featuredDesignFor('m-tee')).toMatchObject({ design: { id: 'night-shift' }, color: 'black', preview: '/designs/previews/night-shift--m-tee.webp' });
    expect(featuredDesignFor('k-jkt')).toBeUndefined();
  });

  it('builds the editor address: a design alone, with a garment, and with a variant', () => {
    expect(customizeUrl('night-shift')).toBe('/design?template=night-shift');
    expect(customizeUrl('night-shift', 'm-tee')).toBe('/design?template=night-shift&product=m-tee');
    expect(customizeUrl('night-shift', 'm-tee', 'M-TEE-BLK-M')).toBe('/design?template=night-shift&product=m-tee&variant=M-TEE-BLK-M');
    expect(customizeUrl('night-shift', undefined, 'M-TEE-BLK-M')).toBe('/design?template=night-shift'); // a variant means nothing without its product
  });
});
