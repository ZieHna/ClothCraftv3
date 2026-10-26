/**
 * API shapes for the storefront.
 *
 * STATUS (step 6): the catalogue, the cart quote, the checkout options and the orders (place, list, read) are FROZEN. They are
 * served by the mock (src/mocks, MSW) and by the real service (backend/, FastAPI in front of Odoo), and the cases in /contract
 * run against both, so the two cannot drift. Not frozen: the mock-only cancel, bank details (placeholders), and real sign-in (6d).
 *
 * What the real service decides itself, because Odoo does not store it (see contract/README.md): the storefront id of a
 * product (the lower-cased garment part of its SKU, SIM-M-TEE-BLK-S -> m-tee), its group (Men, Women, Kids, Babies, from the
 * letter after SIM-), the swatch colours, the low-stock threshold (2 or fewer), and which products are featured. Odoo decides
 * the prices, the VAT, its rounding, and the free stock.
 *
 * Rules the shapes encode:
 *  - Prices and stock are decided by the server. The UI formats and shows them; it never adds, multiplies or counts them.
 *  - Money is a plain number in `currency` (PHP), VAT-inclusive (`vatIncluded`), exactly as the server sends it.
 *  - Every response carries `simulation`. When it is not null, the data is simulated and the UI must say so.
 *
 * Endpoints:
 *   GET /api/catalogue/products                 -> ApiResponse<CatalogueList>
 *        query (all optional): group, type (garment type code), q (name contains), min and max (price, PHP),
 *        stock=1 (only products with something in stock). The server filters and counts; the UI never does.
 *   GET /api/catalogue/products/:id             -> ApiResponse<ProductDetail>
 *   GET /api/catalogue/featured                 -> ApiResponse<FeaturedList>   (the server chooses what is featured)
 *   any error                                   -> ApiErrorBody with the matching HTTP status
 *
 * Cart and orders (plain, non-customised products only; STEP 5a). The cart itself lives in the browser as
 * {sku, quantity} lines; the server prices it on request and checks it again when the order is placed:
 *   POST /api/cart/quote        body {lines: CartLineInput[]}              -> ApiResponse<Quote>      (no sign-in needed)
 *   GET  /api/checkout/options                                              -> ApiResponse<CheckoutOptions>
 *   POST /api/orders            body PlaceOrderRequest, header Idempotency-Key
 *        the same Idempotency-Key again (even at the same moment) returns the same order with 201 and takes stock once
 *        201 ApiResponse<Order>
 *        401 unauthorised     not signed in
 *        422 validation       ApiErrorBody.error.fields = { fieldName: message }
 *        409 stock_conflict   ApiErrorBody.error.lines = the lines that are short; nothing was created, the cart is kept
 *        409 price_changed    ApiErrorBody.error.quote = the new quote; nothing was created
 *   GET  /api/orders, GET /api/orders/:id       -> ApiResponse<Order[]> / ApiResponse<Order>   (the signed-in customer's)
 *   POST /api/orders/:id/received   (step 11, real service only) the customer confirms they received a delivered order, which closes it
 *        200 ApiResponse<Order> (also when pressed again) | 401 | 404 (another customer's order too) | 409 invalid_transition (currentState)
 * Rules the real service must match (they are what the Odoo addon already does at /shop/payment/transaction):
 *  - the stock check is all-or-nothing over every line, lines for one SKU are counted together, and a failure creates no
 *    order and no transaction;
 *  - Cash on delivery AND Bank transfer both confirm the order at once and reserve its stock; a bank-transfer order then
 *    waits for payment, and staff may cancel it, which gives the stock back. No payment deadline exists anywhere;
 *  - money is VAT-inclusive PHP. The VAT portion is stated by the server; the company rounds globally (Quote.vatAmount).
 * Not drafted yet: design in the cart, account details, real sign-in.
 */

export type Group = 'Men' | 'Women' | 'Kids' | 'Babies';
export type ColorId = 'black' | 'white' | 'navy' | 'red' | 'gray';
export type SizeId = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';
export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/** Present on a response whose data is simulated. `label` is the word to show ("Simulated"). */
export interface Simulation {
  label: string;
  note: string;
}

export interface ApiResponse<T> {
  data: T;
  simulation: Simulation | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** 422 validation: field name -> what is wrong with it */
    fields?: Record<string, string>;
    /** 409 stock_conflict: the lines that cannot be supplied */
    lines?: StockProblem[];
    /** 409 price_changed: the cart priced again, to show the shopper before they confirm */
    quote?: Quote;
    /** 429 too_many_attempts: seconds until another attempt is allowed (also the Retry-After header) */
    retryAfter?: number;
    /** staff moves: the state the order is in now (409 invalid_transition, 403 forbidden, 409 state_changed) */
    currentState?: TrackedState;
    /** 409 state_changed: the order as it is now, so the screen can catch up */
    order?: StaffOrder;
    /** 409 cart_conflict (step 12): the saved cart as it is now, to merge this device's edits into */
    cart?: ServerCart;
  };
}

export interface GarmentType {
  code: string;
  name: string;
}

export interface ColorInfo {
  id: ColorId;
  name: string;
  /** swatch colour for display */
  hex: string;
}

/** A colour as one product offers it: the swatch, plus the picture of THIS garment in that colour. */
export interface ColorOption extends ColorInfo {
  /** the garment photo recoloured to this colour (same size as the photo, WebP). Made at build time, so it is the same every time. */
  image: string;
}

export interface Variant {
  sku: string;
  color: ColorId;
  size: SizeId;
  /** the price of this exact variant, final */
  price: number;
  /** how much of `price` is a surcharge for this variant (for example an XXL extra); 0 when none. The server says, the UI never subtracts. */
  priceExtra: number;
  stock: number;
  status: StockStatus;
}

export interface ProductSummary {
  /** the storefront id (m-tee): Odoo's "Storefront id" field (step 8b; it used to be read off the SKU) */
  id: string;
  name: string;
  /** Odoo's "Shop group" field */
  group: Group;
  garmentType: GarmentType;
  /** base price; a variant can differ (for example an XXL extra) */
  price: number;
  /** the real service: Odoo's own picture, /api/catalogue/products/<id>/image?v=<version>; the mock: /products/<id>.webp */
  image: string;
  colors: ColorId[];
  sizes: SizeId[];
  /** units across all variants, and the overall status, both decided by the server */
  stock: number;
  status: StockStatus;
}

export interface Product extends ProductSummary {
  variants: Variant[];
}

/** The product page response: the product with everything needed to show it on its own. */
export interface ProductDetail extends Product {
  currency: 'PHP';
  vatIncluded: boolean;
  /** this product's colours, in order, with the name and swatch to show */
  colorOptions: ColorOption[];
}

/** A garment type that exists in the current result set, with how many products have it. */
export interface GarmentTypeFacet extends GarmentType {
  count: number;
}

/** Featured items for the landing page: which ones is decided by the server, not by the UI. */
export interface FeaturedList {
  currency: 'PHP';
  vatIncluded: boolean;
  products: ProductSummary[];
}

export interface CatalogueList {
  currency: 'PHP';
  vatIncluded: boolean;
  groups: Group[];
  colors: ColorInfo[];
  sizes: SizeId[];
  /** how many products match the query (the length of `products`), stated by the server */
  count: number;
  /** filter choices for the chosen group (not narrowed by the other filters, so choices do not vanish) */
  garmentTypes: GarmentTypeFacet[];
  priceBounds: { min: number; max: number };
  products: ProductSummary[];
}

// ---------------------------------------------------------------- cart, checkout and orders (draft, STEP 5a)

export type PaymentMethodId = 'cod' | 'bank_transfer';
/** The fulfilment status as step 7 knew it (and as the frozen mock still sends it). No deadline is attached to any state. */
export type OrderState = 'awaiting_payment' | 'confirmed' | 'packed' | 'shipped' | 'delivered' | 'cancelled';
/**
 * Step 11, the real service: awaiting_payment -> confirmed -> shipped -> out_for_delivery -> delivered -> closed, or cancelled (before
 * shipped). packed is no longer reached (an order from before step 11 reads as step 1). The mock never sends the two new states.
 */
export type TrackedState = OrderState | 'out_for_delivery' | 'closed';
/** The customer's four steps: 1 received and preparing, 2 shipped out, 3 on delivery, 4 delivered. */
export type TrackingStepId = 'received' | 'shipped' | 'on_delivery' | 'delivered';
/** What the customer sees of the order's progress (real service only). Times only: never who moved it, never a note. */
export interface OrderTracking {
  /** always the four steps, in order; reachedAt is null for a step not reached (or reached before times were recorded) */
  steps: { step: TrackingStepId; reachedAt: string | null }[];
  /** null while a bank transfer waits for payment, and for a cancelled order */
  current: TrackingStepId | null;
  awaitingPayment: boolean;
  closedAt: string | null;
  /** the customer confirmed they received it, or it closed by itself after delivery */
  closedBy: 'customer' | 'automatic' | null;
  /** "Confirm I received my order" is offered (the order is delivered and not yet closed) */
  canConfirm: boolean;
}

/** What the browser keeps for a cart line, and sends to be priced. Never a price. */
export interface CartLineInput {
  sku: string;
  quantity: number;
  /** step 9 (real service only): a customized garment names its uploaded design. A line is (sku, designId): the same garment with and
   *  without a design, or with two designs, is two lines. */
  designId?: string;
}

/** ok: can be supplied. over_stock: fewer in stock than asked. sold_out: none left. unavailable: the SKU is not sold.
 *  design_unavailable (step 9, a DesignedQuoteLine only): its design is gone; the line is not priced and can only be removed. */
export type LineIssue = 'ok' | 'over_stock' | 'sold_out' | 'unavailable' | 'design_unavailable';

export interface StockProblem {
  sku: string;
  available: number;
  message: string;
}

export interface QuoteLine {
  sku: string;
  productId: string;
  name: string;
  colorName: string;
  /** null for an SKU the shop no longer sells (issue "unavailable") */
  size: SizeId | null;
  image: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** units the server can supply right now */
  available: number;
  issue: LineIssue;
  /** a sentence for the shopper when issue is not "ok", else null */
  message: string | null;
}

/** The print fee of a customized garment (step 9), per piece and for the line, VAT included. Every element of a design is priced by its
 *  rotated bounding box; overlaps count once; only what lands on the garment counts. unit = round2(coveredSqIn × rate + sizeStep × steps),
 *  0 when nothing lands on the garment. */
export interface PrintFee {
  coveredSqIn: number;
  rate: number;
  sizeStep: number;
  /** size steps above Small: XS and S 0, M 1, L 2, XL 3, XXL 4 */
  steps: number;
  unit: number;
  total: number;
}

/** A cart line with a design (step 9, real service only). unitPrice and lineTotal are the garment's; the fee is printFee. When the design
 *  is gone (removed, deleted, or not the shopper's): issue design_unavailable, nothing priced (never the plain garment's price), printFee
 *  null, and remedy "remove": the only way on is to remove the line. */
export interface DesignedQuoteLine extends QuoteLine {
  designId: string;
  printFee: PrintFee | null;
  remedy: 'remove' | null;
}

/** A cart priced by the server. The UI shows every number here as it is and adds nothing up. */
export interface Quote {
  currency: 'PHP';
  vatIncluded: boolean;
  /** percent, for example 12 */
  vatRate: number;
  lines: (QuoteLine | DesignedQuoteLine)[];
  deliveryFee: number;
  /** words for the delivery line, for example "Free delivery" (a service setting) */
  deliveryLabel: string;
  total: number;
  /** the part of `total` that is VAT, rounded the way the company rounds (globally, not per line) */
  vatAmount: number;
  /** true when every line can be supplied, so an order could be placed */
  ready: boolean;
}

export interface Province {
  code: string;
  name: string;
}

export interface PaymentMethodOption {
  id: PaymentMethodId;
  label: string;
  description: string;
}

export interface CheckoutOptions {
  currency: 'PHP';
  vatIncluded: boolean;
  vatRate: number;
  provinces: Province[];
  paymentMethods: PaymentMethodOption[];
}

export interface DeliveryDetails {
  fullName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  /** a Province.code */
  province: string;
  postalCode: string;
  note: string;
}

export interface PlaceOrderRequest {
  lines: CartLineInput[];
  delivery: DeliveryDetails;
  paymentMethod: PaymentMethodId;
  /** the total the shopper was shown. If the server's total now differs, the order is refused with 409 price_changed. */
  quotedTotal: number;
}

export interface OrderLine {
  sku: string;
  productId: string;
  name: string;
  colorName: string;
  size: SizeId;
  image: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/** An order line with a design (step 9): the fee as it was ordered (later changes of the settings never change it). */
export interface DesignedOrderLine extends OrderLine {
  designId: string;
  printFee: PrintFee | null;
}

/** Step 9 (real service only), the design routes:
 *   GET    /api/designs/pricing?product=<id>   -> ApiResponse<DesignPricing>   (no sign-in: the editor estimates with it)
 *   POST   /api/designs   body DesignUpload, header Idempotency-Key -> 201 ApiResponse<DesignSummary>   (signed in; at most 28 MB body)
 *          401 | 404 no such garment | 413 too large | 415 not PNG/JPEG/WebP | 422 format, mismatch, limits, not designable | 429 too many designs
 *   GET    /api/designs/:id                       -> ApiResponse<DesignSummary>   (the owner only; anyone else: 404)
 *   GET    /api/designs/:id/preview.png | print.png   -> the picture (the owner only)
 *   DELETE /api/designs/:id                       -> ApiResponse<{removed: true}>, 409 ordered
 *   GET    /api/staff/designs/:id/preview.png | print.png   -> download named <order>-<line>-<sku>.png (staff; a design on an order) */
export interface DesignPricing {
  productId: string;
  /** false when the garment has no print box: it cannot be customized (message says so); no fallback */
  designable: boolean;
  message: string | null;
  /** the garment's bounding rectangle in the 800 × 800 design square: designs are clipped to it */
  box: { x: number; y: number; width: number; height: number } | null;
  /** square inches the box is at size Small */
  referenceSqIn: number;
  rate: number;
  sizeStep: number;
  steps: Record<SizeId, number>;
  /** the scanline band height, design units (for the estimate to match the server's figure) */
  band: number;
  currency: 'PHP';
  vatIncluded: boolean;
  limits: {
    totalBytes: number; pictureBytes: number; pictures: number; elements: number; previewBytes: number; printBytes: number;
    stateBytes: number; printMaxPx: number; previewPx: number;
  };
}

/** One element as the editor's layer list gives it (centre, size after scaling, degrees), plus its opacity. */
export interface DesignGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  opacity: number;
}

export interface DesignUpload {
  schemaVersion: 1;
  /** the garment's storefront id */
  productId: string;
  sku: string;
  /** the editor state, as JSON text (EditorSnapshot without its assets) */
  state: string;
  layers: DesignGeometry[];
  /** the pictures the state uses, by asset id; base64 PNG, JPEG or WebP, at most 5 MB each and 8 in all */
  pictures: { id: string; data: string }[];
  /** base64 PNG, 800 × 800, at most 2 MB */
  preview: string;
  /** base64 transparent PNG, square, at most 4096 px and 12 MB */
  print: string;
}

/** GET /api/designs/:id/state (owner only): what reopening a cart design in the editor needs. */
export interface DesignState {
  design: DesignSummary;
  /** the editor state as uploaded: JSON text of { schemaVersion, engine, state } */
  state: string;
  /** the pictures it uses, by asset id; base64 */
  pictures: { id: string; type: string; data: string }[];
}

export interface DesignSummary {
  id: string;
  productId: string;
  sku: string;
  state: 'draft' | 'ordered';
  coveredSqIn: number;
  layerCount: number;
  printPx: number;
  createdAt: string;
  previewUrl: string;
  printUrl: string;
}

/** Where to send a bank transfer. In the mock these are placeholders and `placeholder` is true. The real service sends them from its own settings (Odoo keeps bank details as free text), still placeholders until the shop has a real account. */
export interface BankDetails {
  placeholder: boolean;
  bankName: string;
  accountName: string;
  accountNumber: string;
  /** what to write on the transfer so the payment can be matched */
  paymentReference: string;
}

export interface Order {
  id: string;
  /** the order number the shopper sees, for example S00001 */
  reference: string;
  state: TrackedState;
  /** ISO 8601 */
  createdAt: string;
  paymentMethod: PaymentMethodId;
  currency: 'PHP';
  vatIncluded: boolean;
  vatRate: number;
  lines: (OrderLine | DesignedOrderLine)[];
  delivery: DeliveryDetails & { provinceName: string };
  deliveryFee: number;
  deliveryLabel: string;
  total: number;
  vatAmount: number;
  /** only for a bank-transfer order */
  bankTransfer: BankDetails | null;
  /** step 11, real service only (the frozen mock does not send it): the customer's four steps */
  tracking?: OrderTracking;
}

// ---------------------------------------------------------------- customer accounts (step 6d)

/**
 * Register, sign in and out, and "who am I". The session is the server's: an httpOnly cookie in the real service (the browser never
 * sees it), and in the mock a token kept in sessionStorage and sent as the X-Mock-Session header. Orders belong to the signed-in customer.
 *   POST /api/auth/register  body RegisterRequest -> 201 ApiResponse<AuthResult> and the customer is signed in
 *        422 validation        ApiErrorBody.error.fields = { name?, email?, password? }
 *        409 email_unavailable "We couldn't create an account with that email. If it is yours, sign in instead."
 *        429 too_many_attempts retryAfter seconds (also the Retry-After header); counts every attempt from one address
 *   POST /api/auth/login     body LoginRequest -> 200 ApiResponse<AuthResult>
 *        401 invalid_credentials the SAME answer for a wrong password, an unknown email and an account that cannot sign in here
 *        429 too_many_attempts   5 failures on one email lock it for 60 s, doubling to 15 minutes, whether or not the account exists
 *        403 mfa_unsupported     real service only: the account uses two-step verification (answered after a CORRECT password, never counted)
 *   POST /api/auth/logout    -> 200 { signedOut: true }, also when nobody was signed in; the session is over for good
 *   GET  /api/auth/me        -> 200 ApiResponse<AuthResult> | 401 unauthorised
 *   every orders route       -> 401 unauthorised without a live session; another customer's order is 404
 * Passwords: 10 to 128 characters, not on the common list, not all one character, not containing the email; no composition rules.
 */
export interface AuthUser {
  /** the customer's id, stable for the account; the browser keys local drafts by it */
  id: string;
  displayName: string;
  email: string;
}
export interface AuthResult {
  user: AuthUser;
}
export interface RegisterRequest {
  name: string;
  email: string;
  password: string;
}
export interface LoginRequest {
  email: string;
  password: string;
}

// ---------------------------------------------------------------- staff dashboard (step 7)

/**
 * The staff routes. Staff are Odoo internal users, kept apart from customers: their own session (a cookie the page cannot read; in the
 * mock the X-Mock-Staff-Session header), and a customer session never opens a staff route nor the other way round. Odoo decides what
 * each person may do and re-reads their groups on every call.
 *   POST /api/staff/auth/login   body {email, password} -> 200 {user: StaffUser} | 401 invalid_credentials | 429 too_many_attempts
 *                                403 mfa_unsupported (real service only: the account uses two-step verification)
 *   POST /api/staff/auth/logout  -> 200 {signedOut: true}      GET /api/staff/auth/me -> 200 {user} | 401 unauthorised
 *   GET  /api/staff/orders       ?state= (repeatable or comma list) &method= &from= &to= (YYYY-MM-DD) &q= &page= &pageSize= (1-100)
 *                                -> StaffOrderList, newest first | 400 bad_state, bad_method, bad_date, bad_page, bad_request
 *   GET  /api/staff/orders/:id   -> StaffOrder (the order, the customer's contact details, the history, the moves allowed to this person
 *                                now, and the blocked ones with a reason) | 404
 *   POST /api/staff/orders/:id/transition  body StaffTransitionRequest -> 200 StaffOrder
 *        409 state_changed       the order is not in `expectedState` any more: nothing was done; error.order is the order as it is now
 *        409 invalid_transition  not a move the order can make from where it is (error.currentState)
 *        403 forbidden           this role may not (Inventory Staff cannot cancel an order whose bank payment was received)
 *        422 validation          error.fields.note / .to
 * Moves: awaiting_payment -> confirmed (shown as "paid") or cancelled; confirmed -> packed or cancelled; packed -> shipped or cancelled;
 * shipped -> delivered. Cancelling a paid bank-transfer order is for an Administrator only, with a note.
 */
export type StaffRole = 'inventory' | 'admin';
export interface StaffUser {
  id: string;
  displayName: string;
  email: string;
  role: StaffRole;
  /** real service only: an Administrator on the employee dashboard while it is employee-only (the server limits that session to the employee role) */
  workingAsEmployee?: boolean;
}
export interface StaffAuthResult {
  user: StaffUser;
}
export interface StaffOrderSummary {
  id: string;
  reference: string;
  state: TrackedState;
  paymentMethod: PaymentMethodId;
  /** the payment has been received (a bank transfer marked as paid, or cash collected on delivery) */
  paid: boolean;
  customer: { name: string; email: string };
  total: number;
  itemCount: number;
  createdAt: string;
  statusChangedAt: string;
  /** step 11, real service only: the order has a customized garment */
  hasDesign?: boolean;
}
export interface StaffOrderList {
  orders: StaffOrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface StaffHistoryLine {
  at: string;
  from: TrackedState;
  to: TrackedState;
  /** the name at the time */
  staff: string;
  note: string;
  /** step 11 adds shop (the customer's own confirmation) and cron (the automatic close) */
  via: 'dashboard' | 'odoo' | 'shop' | 'cron';
  /** step 11, real service only: who, by kind; `staff` then holds the staff member's or the customer's name ('' for automatic) */
  actor?: 'staff' | 'customer' | 'automatic' | 'odoo';
  /** step 11: an Administrator stepped the order back (the note says why) */
  stepBack?: boolean;
}
export interface StaffAllowedMove {
  to: TrackedState;
  label: string;
  needsNote: boolean;
  /** the screen asks "are you sure" first (cancelling) */
  confirm: boolean;
  /** step 11, real service only: back is an Administrator's step back (always with a note) */
  direction?: 'forward' | 'back';
}
export interface StaffBlockedMove {
  to: TrackedState;
  label: string;
  reason: string;
}
export interface StaffOrder extends Order {
  customer: { name: string; email: string; phone: string };
  history: StaffHistoryLine[];
  allowed: StaffAllowedMove[];
  blocked: StaffBlockedMove[];
}
export interface StaffTransitionRequest {
  to: TrackedState;
  /** what the screen showed: if the order has moved since, nothing is done */
  expectedState: TrackedState;
  note?: string;
}
export interface StaffOrderQuery {
  state?: TrackedState;
  method?: PaymentMethodId;
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Step 12 (real shop only): GET /api/cart and PUT /api/cart, the customer's saved cart. No prices: the quote prices it. */
export interface ServerCartLine {
  sku: string;
  productId: string;
  quantity: number;
  selected: boolean;
  designId?: string;
}
export interface ServerCart {
  version: number;
  updatedAt: string | null;
  lines: ServerCartLine[];
}
