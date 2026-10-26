/**
 * The customer's cart: {sku, productId, quantity, designId?} lines and nothing else (plus, for a design, the editor's own estimate,
 * shown only beside the server's figure). No price, no name, no stock: those come from the server (POST /api/cart/quote) every time
 * they are shown.
 */
export interface CartLine {
  sku: string;
  productId: string;
  quantity: number;
  /** step 9: a customized garment names its uploaded design. A line is (sku, designId): the same garment plain, or with two
   *  designs, is two lines. */
  designId?: string;
  /** the print fee per piece the editor estimated when it was added; the cart shows the server's figure and a note when they differ */
  estimate?: number;
  /** step 10: ticked to be ordered. Only a ticked line carries the field; a new line, and every line stored before step 10, is unticked. */
  selected?: true;
}

/** A line's identity: the SKU for a plain garment (as before step 9), the SKU and the design for a customized one. */
export const lineKey = (line: Pick<CartLine, 'sku' | 'designId'>) => (line.designId ? `${line.sku}#${line.designId}` : line.sku);
