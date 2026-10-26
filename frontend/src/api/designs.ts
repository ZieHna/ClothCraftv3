import { apiPath, API_BASE, apiGet, apiSend } from './client';
import type { DesignPricing, DesignState, DesignSummary, DesignUpload } from './types';

/** Customized garments (step 9, the real service only: the frozen mock has no designs). See the route list in types.ts. */
export const getDesignPricing = (productId: string, signal?: AbortSignal) => apiGet<DesignPricing>('/designs/pricing', { product: productId }, signal);

/** `idempotencyKey` is made once per attempt, so a double click or a retry gives the same design. */
export const uploadDesign = (upload: DesignUpload, idempotencyKey: string, signal?: AbortSignal) =>
  apiSend<DesignSummary>('POST', '/designs', upload, { 'Idempotency-Key': idempotencyKey }, signal);

export const getDesignState = (id: string, signal?: AbortSignal) => apiGet<DesignState>(`/designs/${encodeURIComponent(id)}/state`, {}, signal);

/** Remove a design that is not ordered (the server keeps an ordered one). */
export const removeDesign = (id: string) => apiSend<{ removed: boolean }>('DELETE', `/designs/${encodeURIComponent(id)}`);

/** The customer's own picture of a design on the garment (owner only). */
export const designPreviewUrl = (id: string) => `${API_BASE}/designs/${encodeURIComponent(id)}/preview.png`;

/** Staff: the pictures of a design on an order; the print file downloads as <order>-<line>-<sku>.png. */
export const staffDesignUrl = (id: string, kind: 'preview' | 'print') => `${API_BASE}${apiPath('/staff/designs')}/${encodeURIComponent(id)}/${kind}.png`;
