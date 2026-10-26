import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client';
import { removeDesign, uploadDesign } from '../api/designs';
import type { DesignPricing } from '../api/types';
import { cartStore, lineKey } from '../cart/cartStore';
import { DraftSession } from '../drafts/DraftSession';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { formatMoney } from '../lib/format';
import { createEditor } from './createEditor';
import { buildUpload, decodedBytes, estimateFor, geometryOf } from './designUpload';
import { downloadBlob, exportFileName, type ExportKind } from './exportName';
import { BottomSheet } from './panel/BottomSheet';
import { CartActions } from './panel/CartActions';
import { ColorSizePicker, type GarmentOptions } from './panel/ColorSizePicker';
import { ExportPanel } from './panel/ExportPanel';
import { LayersPanel } from './panel/LayersPanel';
import { ContextBar, PhoneToolbar, type SheetName } from './panel/PhoneBars';
import { PropertiesPanel } from './panel/PropertiesPanel';
import { SHAPE_LABEL, ToolRail, UploadProblem, usePictureInput } from './panel/ToolRail';
import { ZoomControls } from './panel/ZoomControls';
import { Icon } from './panel/icons';
import { STRAIGHTENED_NOTE, straightenSnapshot } from './skew';
import { EditorBusyError, LayerLockedError, SHAPE_KINDS, type EditOptions, type EditorMode, type EditorSnapshot, type GarmentBase, type LayerPatch, type ShapeKind, type SimpleEditorTools, type StylePatch } from './types';
import { UploadError } from './upload';
import { ZOOM_STEP } from './view';

interface Props {
  mode: EditorMode;
  garment: GarmentBase;
  /** the product's colours, sizes and what is sold out; with it the editor offers a colour and size picker */
  options?: GarmentOptions;
  /** the editor's garment changed (the picker, or undo and redo): the page follows, e.g. by replacing the URL */
  onGarmentChange?: (garment: { color: string; size: string }) => void;
  /** who is designing which product: with it the design is kept as a draft (see src/drafts). Without it nothing is saved. */
  drafts?: { user: string; productId: string; sku: string };
  /** step 9: the estimate and the buttons that put this design in the cart. Without it the screen only states the pricing rule. */
  cart?: DesignCart;
}

/** How the print-fee settings of this garment stand: the mock shop has none, the real one sends them. */
export type PricingLoad = { phase: 'mock' } | { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready'; pricing: DesignPricing };

export interface DesignCart {
  productId: string;
  pricing: PricingLoad;
  /** the variant for a colour and size: its SKU, its own price (an XXL surcharge included) and whether it is sold out */
  variantFor: (color: string, size: string) => { sku: string; price: number; soldOut: boolean } | undefined;
  /** where the buttons go on a tablet and a desktop (the page header row); the phone has its own row in the bottom bar */
  slot: HTMLElement | null;
  onCheckout: () => void;
  /** "Edit design" from the cart: the line's design is replaced by the new upload, and the old design removed */
  editing?: { designId: string; sku: string };
  /** the design to open (Edit design): loaded once the garment is, instead of a draft */
  initial?: EditorSnapshot;
  onViewCart?: () => void;
}

/** one attempt = one key: a double click or a retry after a lost answer gives the same design */
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(16).slice(2)}`);
const UPLOAD_BUDGET = 20 * 1024 * 1024;
const TOO_LARGE = 'This design is too large to upload (at most 20 MB in all). Use smaller pictures or fewer of them.';

const PHONE = '(max-width: 639.98px), (max-height: 500px) and (pointer: coarse)';
const DESKTOP = '(min-width: 1024px)';
const SHORT = '(max-height: 500px)';
const XWIDE = '(min-width: 1536px)';
const isTypingTarget = (el: EventTarget | null) => el instanceof Element && (el.matches('input, textarea, select, [contenteditable="true"]') || (el as HTMLElement).isContentEditable);
/** a field you TYPE words or numbers into: the browser's own undo, Backspace and arrows belong to it */
const isTextField = (el: EventTarget | null) =>
  el instanceof Element &&
  (el.matches('textarea, [contenteditable="true"]') || (el instanceof HTMLInputElement && !['radio', 'checkbox', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(el.type)) || (el as HTMLElement).isContentEditable);
const NUDGE_BURST_MS = 450;
const HELP_ID = 'editor-shortcuts';

/**
 * The Simple editor screen. Three arrangements around ONE canvas element (so rotating a phone never rebuilds the editor):
 *   desktop (1024 px and up): tools on the left, canvas in the middle, garment, layers and properties on the right
 *   tablet (640 to 1023):     tools in a row above, canvas and the same panels beside it
 *   phone (under 640 px):     the canvas fills the width; a bottom tool bar, a bar for the selected layer, and bottom sheets
 * Price (step 9): with `cart`, an ESTIMATE of the print fee is shown under the canvas, worked out here with the shop's own rule
 * (src/pricing/designFee.ts); the shop's figure is the server's, shown in the cart. Without `cart` only the rule is stated.
 *
 * Lifecycle: the engine is created once per mode and disposed on unmount. Creation is async, so a cleanup that runs first
 * (React StrictMode mounts, unmounts and mounts again) disposes the engine as soon as it arrives.
 * Input: while an undo, redo or load is working the editor refuses edits (EditorBusyError). This screen NEVER lets that
 * show: every action goes through act(), which waits for the editor to be idle and then runs it, in the order it was
 * given, so nothing a person does is lost. If the wait is noticeable a "Working…" note appears.
 * "pro" is not built: it shows a notice and loads nothing.
 */
export function EditorStage({ mode, garment, options, onGarmentChange, drafts, cart }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const toolbarRow = useRef<HTMLDivElement>(null);
  const nudgeTimer = useRef<number | undefined>(undefined);
  const [editor, setEditor] = useState<SimpleEditorTools | null>(null);
  // true once the garment is loaded: only then can a draft be restored or saved
  const [ready, setReady] = useState(false);
  // set by DraftSession while it is saving: leaving calls it so the last edits are written before the editor goes
  const leaveRef = useRef<(() => Promise<void>) | null>(null);
  const editorRef = useRef<SimpleEditorTools | null>(null);
  const [error, setError] = useState('');
  const [uploadProblem, setUploadProblem] = useState('');
  const [notice, setNotice] = useState('');
  const [said, setSaid] = useState({ n: 0, text: '' });
  // the open bottom sheet and which opening of it this is (n goes up on every open). A sheet's native close event can arrive
  // several ms after it closed, when the next sheet (or the same one again) is already open: it clears only its own opening.
  const [sheet, setSheet] = useState<{ name: SheetName; n: number } | null>(null);
  const sheetCount = useRef(0);
  const openSheet = useCallback((name: SheetName) => setSheet({ name, n: ++sheetCount.current }), []);
  const sheetProps = (name: SheetName) => ({
    open: sheet?.name === name,
    openId: sheet?.name === name ? sheet.n : 0,
    onClose: (n: number) => setSheet((s) => (s?.n === n ? null : s)),
  });
  const [handTool, setHandTool] = useState(false);
  const [workingNote, setWorkingNote] = useState(false);
  const spaceDown = useRef(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const phone = useMediaQuery(PHONE);
  // desktop (1024 px and up) fills the window and its columns scroll inside themselves; at 1536 px and up Settings gets its own column
  const desktop = useMediaQuery(DESKTOP) && !phone;
  const xwide = useMediaQuery(XWIDE) && desktop;
  const keyboardOpen = useVisualViewport(phone);

  // ---------------------------------------------------------------- step 9: this design in the cart
  /** goes up on every change of the design or the garment: "Proceed to checkout" right after adding does not send it again */
  const revision = useRef(0);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const [cartWork, setCartWork] = useState<null | 'preparing' | 'sending'>(null);
  const cartWorkRef = useRef<null | 'preparing' | 'sending'>(null);
  const [cartSaid, setCartSaid] = useState<{ kind: 'added' | 'error'; text: string } | null>(null);
  const uploadKey = useRef<{ key: string; revision: number } | null>(null);
  const lastAdded = useRef<{ revision: number; sku: string; key: string } | null>(null);
  const editingRef = useRef(cart?.editing);
  const [straightened, setStraightened] = useState(0);

  const garmentRef = useRef(garment);
  garmentRef.current = garment;
  const followRef = useRef(onGarmentChange);
  followRef.current = onGarmentChange;

  /** One polite live region for every action. A counter lets the same sentence be announced twice in a row. */
  const announce = useCallback((text: string) => setSaid((s) => ({ n: s.n + 1, text })), []);

  const picture = usePictureInput((file) => void pickFile(file));

  useEffect(() => {
    const el = host.current;
    if (mode !== 'simple' || !el) return;
    let live = true;
    let created: SimpleEditorTools | null = null;
    const offs: Array<() => void> = [];
    createEditor(mode, el)
      .then(async (next) => {
        if (!live) {
          next.dispose();
          return;
        }
        created = next;
        editorRef.current = next;
        offs.push(
          next.onChange(() => {
            revision.current++;
            redraw();
            // the garment changed inside the editor (the picker, or undo and redo): the page follows
            const g = next.getGarment();
            const page = garmentRef.current;
            if (g.color && (g.color !== page.color || g.size !== page.size)) followRef.current?.(g);
          }),
          next.onSelectionChange(redraw),
          next.onViewChange(redraw),
        );
        setEditor(next);
        await next.loadBase(garmentRef.current);
        if (live) setReady(true);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'The editor could not start.');
      });
    return () => {
      live = false;
      window.clearTimeout(nudgeTimer.current);
      for (const off of offs) off();
      // unsaved edits are written first (the editor is still alive while that happens), then the editor goes
      const leaving = leaveRef.current?.();
      if (leaving) void leaving.finally(() => created?.dispose());
      else created?.dispose();
      editorRef.current = null;
      setEditor(null);
      setReady(false);
    };
  }, [mode]);

  /** A "Working…" note only when the wait is long enough to notice (a cold picture decode), never a flash. */
  const busy = !!editor?.isBusy();
  useEffect(() => {
    if (!busy) {
      setWorkingNote(false);
      return;
    }
    const t = window.setTimeout(() => setWorkingNote(true), 150);
    return () => window.clearTimeout(t);
  }, [busy]);

  // phone: the fixed bottom bars need room under the page, so the footer is not hidden behind them (the action row: 4.75rem more)
  // a phone on its side has no height for the action row: the buttons go at the end of the tool bar instead (the bars stay as tall as before)
  const short = useMediaQuery(SHORT) && phone;
  const withActions = !!cart && !short;
  useEffect(() => {
    if (!phone) return;
    const el = document.documentElement;
    el.style.paddingBottom = `calc(${withActions ? '9.25rem' : '4.5rem'} + env(safe-area-inset-bottom))`;
    return () => {
      el.style.paddingBottom = '';
    };
  }, [phone, withActions]);
  useEffect(() => {
    if (!phone) setSheet(null);
  }, [phone]);
  // phone: once the editor is ready, bring the canvas up to the top of the screen, so all of it shows above the fixed bars
  // (the page's own heading is above it; it is one scroll away). Only if the person has not scrolled yet.
  useEffect(() => {
    if (!phone || !editor || window.scrollY > 4) return;
    const id = requestAnimationFrame(() => toolbarRow.current?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(id);
  }, [phone, editor]);

  // ---------------------------------------------------------------- the page and the editor agree on colour and size
  const report = useCallback(
    (e: unknown) => {
      if (e instanceof LayerLockedError) {
        setNotice(e.message);
        announce(`Not changed. ${e.message}`);
      } else if (!(e instanceof EditorBusyError)) {
        throw e;
      }
    },
    [announce],
  );

  /**
   * Runs a user action. If the editor is busy (an undo, redo or load is working) the action waits for it and then runs,
   * in order: nothing is dropped and nothing is applied to a scene that is about to be replaced. A locked layer is
   * reported in words and aloud instead of failing silently.
   */
  const act = useCallback(
    (action: () => void | Promise<void>) => {
      const run = (): void => {
        const ed = editorRef.current;
        if (!ed) return;
        if (ed.isBusy()) {
          void ed.whenIdle().then(run);
          return;
        }
        try {
          setNotice('');
          const result = action();
          if (result) void result.catch(report);
        } catch (e) {
          report(e);
        }
      };
      run();
    },
    [report],
  );

  useEffect(() => {
    if (!editor) return;
    const g = editor.getGarment();
    if (g.color && g.color !== garment.color) act(() => editor.setColor(garment.color));
  }, [editor, garment.color, act]);
  useEffect(() => {
    if (!editor) return;
    const g = editor.getGarment();
    if (g.size && g.size !== garment.size) act(() => editor.setSize(garment.size));
  }, [editor, garment.size, act]);

  const layers = editor?.getLayers() ?? [];
  const selectedId = editor?.getSelection() ?? null;
  const layer = selectedId ? layers.find((l) => l.id === selectedId) : undefined;
  const style = selectedId && layer && editor ? editor.getStyle(selectedId) : null;
  const view = editor?.getView() ?? null;
  const wordFor = (l: { type: string; name: string }) => (l.type === 'image' ? 'picture' : l.type === 'text' ? 'text' : l.name.toLowerCase());
  const current = editor?.getGarment() ?? { color: garment.color, size: garment.size };

  // the estimate: recomputed on every change (about 7 ms with 50 elements, measured in Edge), never a call to the server
  const pricing = cart?.pricing.phase === 'ready' ? cart.pricing.pricing : null;
  const variant = cart?.variantFor(current.color, current.size);
  // nothing to print yet: only the rule is stated (a figure of ₱0 for an empty design would say nothing)
  const est = editor && ready && pricing?.designable && layers.some((l) => l.visible) ? estimateFor(geometryOf(editor), pricing, current.size) : null;
  // inches per design unit at size Small: the garment's print box is the garment type's print area there (display only)
  const inchPerUnit = pricing?.box ? Math.sqrt(pricing.referenceSqIn / (pricing.box.width * pricing.box.height)) : undefined;
  let cartReason: string | null = null;
  if (cart) {
    if (cart.pricing.phase === 'mock') cartReason = 'Ordering a design needs the real shop.';
    else if (cart.pricing.phase === 'loading') cartReason = 'One moment: loading the print prices.';
    else if (cart.pricing.phase === 'error') cartReason = cart.pricing.message;
    else if (!cart.pricing.pricing.designable) cartReason = cart.pricing.pricing.message ?? 'This garment cannot be customized yet.';
    else if (!editor || !ready || busy) cartReason = 'One moment: the editor is finishing.';
    else if (!layers.some((l) => l.visible)) cartReason = 'Add something to your design first.';
    else if (!variant || variant.soldOut) cartReason = 'This size is sold out.';
  }

  // Edit design (from the cart): the saved design is opened once the garment is in, straightened if it was slanted
  const initialDone = useRef(false);
  useEffect(() => {
    const initial = cartRef.current?.initial;
    if (!editor || !ready || !initial || initialDone.current) return;
    initialDone.current = true;
    const { snapshot, straightened: n } = straightenSnapshot(initial);
    editor
      .loadState(snapshot)
      .then(() => {
        setStraightened(n);
        announce(n ? `Your design was opened. ${STRAIGHTENED_NOTE(n)}` : 'Your design was opened.');
      })
      .catch(() => setError('This design could not be opened.'));
  }, [editor, ready, announce]);

  const work = (w: null | 'preparing' | 'sending') => {
    cartWorkRef.current = w;
    setCartWork(w);
  };
  /**
   * Take the design for the cart: wait for the editor, cover the screen while the state, the element list and both pictures are
   * taken from the same scene ("Preparing your design…"), then let go of the editor and send it. A failure shows the shop's own
   * sentence and changes nothing: the design stays open and the draft is untouched. The same attempt keeps its Idempotency-Key.
   */
  const addToCart = async (thenCheckout: boolean) => {
    const ed = editorRef.current;
    const c = cartRef.current;
    if (!ed || !c || cartReason || cartWorkRef.current) return;
    const g = ed.getGarment();
    const v = c.variantFor(g.color, g.size);
    if (!v) return;
    if (thenCheckout && lastAdded.current && lastAdded.current.revision === revision.current && lastAdded.current.sku === v.sku) {
      cartStore.selectOnly(lastAdded.current.key); // step 10: this design alone is checked out; the rest stays in the cart, unticked
      c.onCheckout();
      return;
    }
    setCartSaid(null);
    work('preparing');
    const rev = revision.current;
    let upload;
    try {
      upload = await buildUpload(ed, c.productId, v.sku);
    } catch {
      work(null);
      setCartSaid({ kind: 'error', text: 'Your design could not be prepared. Please try again.' });
      return;
    }
    const fee = c.pricing.phase === 'ready' ? estimateFor(upload.layers, c.pricing.pricing, g.size)?.fee : undefined;
    if (decodedBytes(upload) > UPLOAD_BUDGET) {
      work(null);
      setCartSaid({ kind: 'error', text: TOO_LARGE });
      announce(`Not added. ${TOO_LARGE}`);
      return;
    }
    work('sending');
    if (!uploadKey.current || uploadKey.current.revision !== rev) uploadKey.current = { key: newKey(), revision: rev };
    try {
      const response = await uploadDesign(upload, uploadKey.current.key);
      uploadKey.current = null;
      const design = { id: response.data.id, estimate: fee };
      const editing = editingRef.current;
      if (editing) {
        const oldKey = lineKey({ sku: editing.sku, designId: editing.designId });
        if (cartStore.get().lines.some((l) => lineKey(l) === oldKey)) cartStore.replaceDesign(oldKey, design, v.sku);
        else cartStore.add(v.sku, c.productId, 1, design);
        if (editing.designId !== design.id) void removeDesign(editing.designId).catch(() => undefined); // the old one is not in the cart any more
        editingRef.current = { designId: design.id, sku: v.sku };
      } else {
        cartStore.add(v.sku, c.productId, 1, design);
      }
      const key = lineKey({ sku: v.sku, designId: design.id });
      lastAdded.current = { revision: rev, sku: v.sku, key };
      const text = editing ? 'Your cart now has this version of the design.' : 'Added to your cart.';
      setCartSaid({ kind: 'added', text });
      announce(text);
      work(null);
      if (thenCheckout) {
        cartStore.selectOnly(key); // step 10: this design alone is checked out; the rest stays in the cart, unticked
        c.onCheckout();
      }
    } catch (e) {
      work(null);
      if (e instanceof ApiError) {
        uploadKey.current = null; // an answer came: the next attempt is a new one
        setCartSaid({ kind: 'error', text: e.message });
        announce(`Not added. ${e.message}`);
      } else {
        // no answer (offline?): the key is kept, so pressing again cannot make two designs if the first one got through
        const text = 'Could not reach the shop. Your design is still here; press the button again.';
        setCartSaid({ kind: 'error', text });
        announce(text);
      }
    }
  };

  const removeLayer = useCallback(
    (id: string, focusAfter?: HTMLElement | null) => {
      act(() => {
        const ed = editorRef.current;
        const found = ed?.getLayers().find((l) => l.id === id);
        if (!ed || !found) return;
        ed.removeLayer(id);
        announce(`Deleted ${wordFor(found)}.`);
        (focusAfter ?? panel.current)?.focus(); // the button that was pressed is gone: keep keyboard focus somewhere sensible
      });
    },
    [act, announce],
  );

  const undo = useCallback(() => {
    window.clearTimeout(nudgeTimer.current);
    // undo and redo are queued by the editor itself: pressing them ten times quickly is ten steps, in order
    const ed = editorRef.current;
    if (!ed?.canUndo()) return;
    setNotice('');
    void ed.undo().then(() => announce('Undone.'));
  }, [announce]);
  const redo = useCallback(() => {
    const ed = editorRef.current;
    if (!ed?.canRedo()) return;
    setNotice('');
    void ed.redo().then(() => announce('Redone.'));
  }, [announce]);

  const syncPan = useCallback((hand: boolean) => editorRef.current?.setPanMode(hand || spaceDown.current), []);
  const toggleHand = () => {
    const next = !handTool;
    setHandTool(next);
    syncPan(next);
    announce(next ? 'Hand tool on. Drag the canvas to move around.' : 'Hand tool off.');
  };

  // Keyboard on the design. Never while typing in a field (the panel's, a rename box, or Fabric's own text editing,
  // which uses a hidden textarea), and never from outside this editor.
  useEffect(() => {
    if (!editor) return;
    const outside = (active: Element | null) => !!active && active !== document.body && !root.current?.contains(active);
    const onKey = (e: KeyboardEvent) => {
      // while the design is being taken for the cart nothing may change it (the cover blocks the pointer)
      if (cartWorkRef.current === 'preparing') return;
      const active = document.activeElement;
      // e.target as well as the focused element: Escape in Fabric's text editing blurs its hidden textarea while the key is still being handled
      if (outside(active)) return;
      // a bottom sheet is open: its keys (Esc to close, Tab, arrows in its fields) are its own, and the design behind it is out of reach
      if (root.current?.querySelector('dialog[open]')) return;
      const mod = e.ctrlKey || e.metaKey;
      // Undo and redo work from anywhere in the editor except a text field (a radio or a button has no undo of its own)
      if (mod && !e.altKey) {
        if (isTextField(e.target) || isTextField(active)) return;
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (key === 'y' && !e.metaKey) {
          e.preventDefault();
          redo();
        }
        return;
      }
      if (e.altKey) return;
      if (isTypingTarget(e.target) || isTypingTarget(active)) return;
      // zoom: + - 0, and Space held for the hand (only when nothing else has the focus: Space presses a focused button)
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        editor.zoomBy(ZOOM_STEP);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        editor.zoomBy(1 / ZOOM_STEP);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        editor.zoomFit();
        return;
      }
      if (e.key === ' ' && active === document.body) {
        e.preventDefault();
        if (!spaceDown.current) {
          spaceDown.current = true;
          syncPan(handTool);
        }
        return;
      }
      if (e.key === 'Escape') {
        if (document.querySelector(':popover-open')) return; // Escape belongs to the help popover then
        act(() => editor.select(null));
        return;
      }
      const id = editor.getSelection();
      if (!id) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeLayer(id, active === document.body ? null : (active as HTMLElement));
        return;
      }
      const step = e.shiftKey ? 10 : 1;
      const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const d = move[e.key];
      if (!d) return;
      e.preventDefault();
      // a burst of arrow presses is ONE history step: each press is live, the step is recorded when the burst pauses
      act(() => {
        const l = editor.getLayers().find((x) => x.id === id);
        if (!l) return;
        editor.updateLayer(id, { x: l.x + d[0], y: l.y + d[1] }, { live: true });
        window.clearTimeout(nudgeTimer.current);
        nudgeTimer.current = window.setTimeout(() => editor.commitEdit(), NUDGE_BURST_MS);
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceDown.current) {
        spaceDown.current = false;
        syncPan(handTool);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
    };
  }, [editor, undo, redo, removeLayer, act, syncPan, handTool]);

  async function pickFile(file: File) {
    const ed = editorRef.current;
    if (!ed) return;
    setUploadProblem('');
    announce('Adding the picture.');
    try {
      await ed.whenIdle();
      await ed.addImage(file, file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Picture');
      announce('Picture added. Its settings are available in the settings.');
    } catch (e) {
      const message = e instanceof UploadError ? e.message : 'That picture could not be added.';
      setUploadProblem(message);
      announce(`Picture not added. ${message}`);
    }
  }

  const changeStyle = async (patch: StylePatch, opts?: EditOptions) => {
    const ed = editorRef.current;
    if (!ed || !selectedId) return;
    await ed.whenIdle();
    try {
      setNotice('');
      await ed.updateStyle(selectedId, patch, opts);
    } catch (e) {
      report(e);
    }
  };
  const changeLayer = (patch: LayerPatch, opts?: EditOptions) => {
    if (editor && selectedId) act(() => editor.updateLayer(selectedId, patch, opts));
  };

  const addText = () =>
    act(() => {
      editor?.addText('Your text');
      announce('Text added.');
    });
  const addShape = (kind: ShapeKind) =>
    act(() => {
      editor?.addShape(kind);
      announce(`${SHAPE_LABEL[kind]} added.`);
    });
  const moveLayer = (id: string, direction: 'up' | 'down') =>
    act(() => {
      editor?.moveLayer(id, direction);
      const top = editor?.getLayers().reverse() ?? [];
      const at = top.findIndex((l) => l.id === id) + 1;
      announce(`Moved ${top[at - 1]?.name ?? 'layer'} ${direction}. Now layer ${at} of ${top.length}, counting from the top.`);
    });
  const toggle = (id: string, key: 'visible' | 'locked') =>
    act(() => {
      const l = editor?.getLayers().find((x) => x.id === id);
      if (!editor || !l) return;
      editor.updateLayer(id, { [key]: !l[key] });
      announce(key === 'visible' ? `${l.visible ? 'Hid' : 'Showed'} ${l.name}.` : `${l.locked ? 'Unlocked' : 'Locked'} ${l.name}.`);
    });
  const rotateBy = (degrees: number) =>
    act(() => {
      if (!editor || !layer) return;
      editor.updateLayer(layer.id, { rotation: (layer.rotation + degrees + 360) % 360 });
      announce(`Rotated ${Math.abs(degrees)} degrees ${degrees < 0 ? 'left' : 'right'}.`);
    });
  const pickGarment = (pick: { color?: string; size?: string }) =>
    act(() => {
      if (!editor) return;
      if (pick.color) {
        editor.setColor(pick.color);
        announce(`Colour changed to ${options?.colors.find((c) => c.id === pick.color)?.name ?? pick.color}. Your design is kept.`);
      }
      if (pick.size) {
        editor.setSize(pick.size);
        announce(`Size changed to ${pick.size}. Your design is kept.`);
      }
    });

  const doExport = async (kind: ExportKind, scale: 1 | 2) => {
    const ed = editorRef.current;
    if (!ed) return;
    try {
      await ed.whenIdle();
      const g = ed.getGarment();
      const blob = await ed.exportPng({ withGarment: kind === 'preview', multiplier: scale });
      const colour = options?.colors.find((c) => c.id === g.color)?.name ?? g.color;
      downloadBlob(blob, exportFileName({ product: options?.productName ?? 'design', color: colour, size: g.size, kind, scale }));
      announce(kind === 'preview' ? 'The preview was downloaded.' : 'The design-only file was downloaded.');
    } catch {
      announce('The picture could not be made. Please try again.');
    }
  };

  if (mode === 'pro') {
    return (
      <p role="status" className="mt-6 border border-dashed border-brown/70 bg-cream p-4">
        The Pro editor is not available yet. Choose Simple to start designing.
      </p>
    );
  }

  const canUndo = !!editor?.canUndo();
  const canRedo = !!editor?.canRedo();
  const barButton = 'btn btn-secondary btn-small px-3 max-sm:min-h-11 aria-disabled:cursor-not-allowed aria-disabled:border-muted aria-disabled:text-muted';
  const undoRedo = (
    <>
      <button type="button" aria-disabled={!canUndo} aria-keyshortcuts="Control+Z Meta+Z" onClick={undo} className={barButton}>
        Undo
      </button>
      <button type="button" aria-disabled={!canRedo} aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z" onClick={redo} className={barButton}>
        Redo
      </button>
    </>
  );
  const zoom = view && (
    <ZoomControls
      view={view}
      handTool={handTool}
      onZoomOut={() => editor?.zoomBy(1 / ZOOM_STEP)}
      onZoomIn={() => editor?.zoomBy(ZOOM_STEP)}
      onFit={() => editor?.zoomFit()}
      onActual={() => editor?.zoomActual()}
      onHand={toggleHand}
    />
  );

  const layersPanelFor = (bare: boolean) => (
    <LayersPanel
      bare={bare}
      layers={[...layers].reverse()}
      selectedId={selectedId}
      notice={notice}
      onSelect={(id) => act(() => editor?.select(id))}
      onMove={moveLayer}
      onToggleVisible={(id) => toggle(id, 'visible')}
      onToggleLocked={(id) => toggle(id, 'locked')}
      onDelete={(id) => removeLayer(id)}
      onRename={(id, name) => act(() => editor?.updateLayer(id, { name }, { live: true }))}
      onRenameDone={() => {
        editor?.commitEdit();
        announce('Renamed.');
      }}
    />
  );
  const propertiesPanelFor = (bare: boolean) => (
    <PropertiesPanel ref={panel} bare={bare} layer={layer ?? null} style={style} onStyle={changeStyle} onLayer={changeLayer} onCommit={() => editor?.commitEdit()} onDelete={() => selectedId && removeLayer(selectedId)} inchPerUnit={inchPerUnit} />
  );
  const garmentPanel = options ? (
    <section aria-labelledby="garment-title" className="stitched border border-tan bg-cream p-4" data-testid="garment-panel">
      <h2 id="garment-title" className="relative mb-3 text-2xl">
        Garment
      </h2>
      <div className="relative">
        <ColorSizePicker options={options} value={current} onPick={pickGarment} disabled={!editor} />
      </div>
    </section>
  ) : null;
  const exportPanelFor = (bare: boolean, compact = false) => <ExportPanel bare={bare} compact={compact} disabled={!editor} onExport={doExport} />;
  const problemId = 'upload-problem-text';
  const cartActions = (variant: 'header' | 'phone' | 'inline') =>
    cart ? (
      <CartActions
        variant={variant}
        reason={cartWork ? null : cartReason}
        working={cartWork === 'preparing' ? (variant !== 'header' ? 'Preparing…' : 'Preparing your design…') : cartWork === 'sending' ? (variant !== 'header' ? 'Sending…' : 'Sending your design…') : null}
        editing={!!editingRef.current}
        onAdd={() => void addToCart(false)}
        onCheckout={() => void addToCart(true)}
      />
    ) : undefined;

  return (
    <div ref={root} className={phone ? '-mx-4 mt-2 grid' : 'mt-6 grid gap-4 sm:grid-cols-[minmax(0,1fr)_19rem] lg:mt-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[11.5rem_minmax(0,1fr)_19rem] lg:grid-rows-[minmax(0,1fr)] lg:gap-6 2xl:grid-cols-[13rem_minmax(0,1fr)_19rem_19rem]'} data-layout={phone ? 'phone' : 'wide'} aria-busy={busy || cartWork === 'preparing'}>
      {phone ? null : (
        <div className="sm:col-span-2 lg:col-span-1 lg:min-h-0">
          {desktop ? (
            <ScrollRegion label="Tools and download, scrollable" className="flex flex-col gap-3">
              <ToolRail disabled={!editor} uploadProblem={uploadProblem} onAddText={addText} onAddShape={addShape} onPickFile={(f) => void pickFile(f)} />
              {exportPanelFor(false, true)}
            </ScrollRegion>
          ) : (
            <ToolRail disabled={!editor} uploadProblem={uploadProblem} onAddText={addText} onAddShape={addShape} onPickFile={(f) => void pickFile(f)} />
          )}
        </div>
      )}

      <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-col">
        <div ref={toolbarRow} className={phone ? 'mb-2 flex scroll-mt-2 items-center gap-2 px-4' : 'mx-auto mb-3 flex w-full max-w-[40rem] flex-wrap items-center gap-2 lg:mx-0 lg:mb-2 lg:max-w-none lg:gap-1.5'} role="toolbar" aria-label="History and view">
          {undoRedo}
          {phone ? (
            <button type="button" onClick={() => editor?.zoomFit()} className={`${barButton} ml-auto`} aria-label={`Fit the whole design in view, now ${Math.round((view?.zoom ?? 1) * 100)} percent`}>
              <span aria-hidden="true">{Math.round((view?.zoom ?? 1) * 100)}% · Fit</span>
            </button>
          ) : (
            <>
              <span className="mx-1 hidden h-6 border-l border-tan sm:block lg:hidden" aria-hidden="true" />
              {zoom}
              <button type="button" popoverTarget={HELP_ID} className={`${barButton} ml-auto`}>
                Shortcuts
              </button>
            </>
          )}
        </div>
        {/* the canvas: one element for every layout, square. On a phone and a tablet it is as wide as its column. On a desktop it
            takes whatever height the window has left (this region is a size container, so the canvas is the smaller of its width
            and its height, never under 20rem = 320 px; the window grows a scrollbar before it goes smaller than that). */}
        <div className="lg:flex lg:min-h-0 lg:flex-1 lg:items-start lg:justify-center lg:[container-type:size]">
          <div
            ref={host}
            className={phone ? `mx-auto w-full ${withActions ? 'max-w-[min(100%,max(12rem,calc(100dvh-15.75rem)))]' : 'max-w-[min(100%,max(12rem,calc(100dvh-11rem)))]'} border-y border-tan bg-paper` : 'mx-auto w-full max-w-[40rem] border border-tan bg-paper lg:w-[max(20rem,min(100cqw,100cqh))] lg:max-w-none lg:flex-none'}
            data-testid="editor-host"
          />
        </div>
        {workingNote && (
          <p role="status" className="mt-2 px-4 text-center text-sm font-medium text-ink" data-testid="working-note">
            Working on it…
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 px-4 text-brown-dark">
            Problem: {error}
          </p>
        )}
        {drafts && editor && ready && (
          <DraftSession
            editor={editor}
            user={drafts.user}
            productId={drafts.productId}
            engine={mode}
            describe={() => ({
              sku: drafts.sku,
              productName: options?.productName ?? 'Design',
              colorName: options?.colors.find((c) => c.id === editor.getGarment().color)?.name ?? editor.getGarment().color,
            })}
            options={options}
            onDownload={() => void doExport('design', 2)}
            announce={announce}
            leaveRef={leaveRef}
          />
        )}
        {phone && uploadProblem && (
          <div className="px-4">
            <UploadProblem id={problemId} text={uploadProblem} />
          </div>
        )}
        <p className="mt-3 px-4 text-center text-sm text-muted sm:px-0 lg:mt-2" data-testid="design-estimate">
          {est && variant ? (
            <>
              <span className="font-medium text-ink">
                Estimated price {formatMoney(variant.price + est.fee, 'PHP')} each
              </span>{' '}
              (print {formatMoney(est.fee, 'PHP')}, {est.coveredSqIn.toFixed(2)} sq in).{' '}
            </>
          ) : null}
          Every element is priced by the rectangle around it.
        </p>
        {straightened > 0 && (
          <p role="status" className="mx-4 mt-2 border border-brown bg-cream p-3 text-sm font-medium text-brown-dark sm:mx-0" data-testid="design-straightened">
            {STRAIGHTENED_NOTE(straightened)}
          </p>
        )}
        {cartSaid && (
          <p role={cartSaid.kind === 'error' ? 'alert' : 'status'} className={`mx-4 mt-2 text-center text-sm font-medium sm:mx-0 ${cartSaid.kind === 'error' ? 'text-brown-dark' : 'text-sage-dark'}`} data-testid="design-cart-said">
            {cartSaid.text}{' '}
            {cartSaid.kind === 'added' && cart?.onViewCart && (
              <button type="button" onClick={cart.onViewCart} className="underline underline-offset-4">
                View cart
              </button>
            )}
          </p>
        )}
        {phone || desktop ? null : <div className="mx-auto mt-4 w-full max-w-[40rem]">{exportPanelFor(false)}</div>}
      </div>

      {phone ? null : !desktop ? (
        <div className="flex min-w-0 flex-col gap-4 lg:gap-6">
          {garmentPanel}
          {layersPanelFor(false)}
          {propertiesPanelFor(false)}
        </div>
      ) : xwide ? (
        <>
          <ScrollRegion label="Garment and layers, scrollable" className="flex flex-col gap-6">
            {garmentPanel}
            {layersPanelFor(false)}
          </ScrollRegion>
          <ScrollRegion label="Settings, scrollable">{propertiesPanelFor(false)}</ScrollRegion>
        </>
      ) : (
        <ScrollRegion label="Garment, layers and settings, scrollable" className="flex flex-col gap-6">
          {garmentPanel}
          {layersPanelFor(false)}
          {propertiesPanelFor(false)}
        </ScrollRegion>
      )}

      {phone && !keyboardOpen && (
        <>
          {layer && <ContextBar name={layer.name} locked={layer.locked} raised={withActions} onSettings={() => openSheet('settings')} onRotate={rotateBy} onDelete={() => removeLayer(layer.id)} />}
          <PhoneToolbar disabled={!editor} uploadProblemId={uploadProblem ? problemId : undefined} onText={addText} onPicture={picture.open} onSheet={openSheet} actions={withActions ? cartActions('phone') : undefined} inlineActions={cart && short ? cartActions('inline') : undefined} />
        </>
      )}
      {phone ? picture.element : null}

      {phone && (
        <>
          <BottomSheet {...sheetProps('shapes')} title="Shapes">
            <ul className="grid grid-cols-2 gap-2">
              {SHAPE_KINDS.map((kind) => (
                <li key={kind}>
                  <button
                    type="button"
                    onClick={() => {
                      addShape(kind);
                      setSheet(null);
                    }}
                    className="btn btn-secondary min-h-14 w-full justify-start gap-3"
                  >
                    <Icon name={kind} />
                    {SHAPE_LABEL[kind]}
                  </button>
                </li>
              ))}
            </ul>
          </BottomSheet>
          <BottomSheet {...sheetProps('layers')} title="Layers">
            {layersPanelFor(true)}
          </BottomSheet>
          <BottomSheet {...sheetProps('colour')} title="Colour and size">
            {options ? <ColorSizePicker options={options} value={current} onPick={pickGarment} disabled={!editor} /> : <p className="text-sm text-text">This garment has no other colours or sizes to choose here.</p>}
          </BottomSheet>
          <BottomSheet {...sheetProps('settings')} title={layer ? `${layer.name} settings` : 'Settings'}>
            {propertiesPanelFor(true)}
          </BottomSheet>
          <BottomSheet {...sheetProps('more')} title="More">
            <div className="flex flex-col gap-4">
              <div role="group" aria-label="History" className="flex flex-wrap gap-2">
                {undoRedo}
              </div>
              {zoom}
              {exportPanelFor(true)}
              <TouchHelp />
            </div>
          </BottomSheet>
        </>
      )}

      <div id={HELP_ID} popover="auto" aria-labelledby={`${HELP_ID}-title`} className="m-auto w-[min(92vw,26rem)] border border-brown bg-cream p-0 text-text backdrop:bg-ink/55">
        <div className="m-2 border border-dashed border-brown/70 p-5">
          <h2 id={`${HELP_ID}-title`} className="text-3xl">
            Shortcuts
          </h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="font-semibold text-ink">Ctrl+Z</dt>
            <dd>Undo (Cmd+Z on a Mac)</dd>
            <dt className="font-semibold text-ink">Ctrl+Shift+Z or Ctrl+Y</dt>
            <dd>Redo</dd>
            <dt className="font-semibold text-ink">Delete or Backspace</dt>
            <dd>Delete the selected layer</dd>
            <dt className="font-semibold text-ink">Esc</dt>
            <dd>Deselect</dd>
            <dt className="font-semibold text-ink">Arrow keys</dt>
            <dd>Move the selected layer 1 px (10 px with Shift)</dd>
            <dt className="font-semibold text-ink">+ and -</dt>
            <dd>Zoom in and out (Ctrl and the mouse wheel does too)</dd>
            <dt className="font-semibold text-ink">0</dt>
            <dd>Fit the whole design in view</dd>
            <dt className="font-semibold text-ink">Space, then drag</dt>
            <dd>Move around a zoomed canvas (or use the Hand button)</dd>
            <dt className="font-semibold text-ink">Double-click text</dt>
            <dd>Type on the garment itself</dd>
          </dl>
          <p className="mt-3 text-sm text-muted">Shortcuts pause while you type in a box.</p>
          <TouchHelp />
          <button type="button" popoverTarget={HELP_ID} popoverTargetAction="hide" className="btn btn-secondary mt-4">
            Close
          </button>
        </div>
      </div>

      {cart?.slot && !phone ? createPortal(cartActions('header'), cart.slot) : null}
      {cartWork === 'preparing' && (
        // the scene is being taken for the cart: nothing may change it for this moment
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30" data-testid="design-preparing">
          <p className="border border-brown bg-cream px-5 py-3 text-lg font-medium text-ink">Preparing your design…</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only" data-testid="live-region">
        {said.text}
        {said.n % 2 ? '' : ' '}
      </p>
    </div>
  );
}

/**
 * A column of the desktop editor that is taller than the window scrolls INSIDE itself, never the page. It is a named region
 * and a tab stop, so a keyboard user can focus it and scroll it with the arrow and page keys; it has a visible focus ring and a
 * thin scrollbar that is always drawn (index.css .scroll-col), and reaching its end does not scroll the page behind it.
 */
function ScrollRegion({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={`scroll-col h-full min-h-0 pr-2 ${className}`}>
      {children}
    </div>
  );
}

/** The touch rule, in words, wherever help is shown. */
function TouchHelp() {
  return (
    <div className="mt-3 text-sm text-text" data-testid="touch-help">
      <h3 className="text-xl">On a touch screen</h3>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>One finger: pick a layer and drag it.</li>
        <li>Two fingers with a layer selected: pinch to resize it and twist to rotate it.</li>
        <li>Two fingers with nothing selected: pinch to zoom the canvas and slide to move around it.</li>
        <li>To use two fingers on the canvas instead of a layer, tap an empty spot first to deselect.</li>
      </ul>
    </div>
  );
}
