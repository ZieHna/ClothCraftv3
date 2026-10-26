import { apiGet } from './client';
import type { CatalogueList, FeaturedList, Group, ProductDetail } from './types';

/** The Category page's filters. Every field is optional; the server does the filtering and the counting. */
export interface ProductQuery {
  group?: Group;
  /** garment type code, for example "TEE" */
  type?: string;
  /** name contains */
  q?: string;
  /** price range in PHP, as typed (the server validates it) */
  min?: string;
  max?: string;
  inStock?: boolean;
}

export const listProducts = (query: ProductQuery = {}, signal?: AbortSignal) =>
  apiGet<CatalogueList>('/catalogue/products', { group: query.group, type: query.type, q: query.q, min: query.min, max: query.max, stock: query.inStock ? '1' : undefined }, signal);
export const listFeatured = (signal?: AbortSignal) => apiGet<FeaturedList>('/catalogue/featured', {}, signal);
export const getProduct = (id: string, signal?: AbortSignal) => apiGet<ProductDetail>(`/catalogue/products/${encodeURIComponent(id)}`, {}, signal);
