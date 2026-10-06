// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { hitTest, type Bounds, type Scene } from "../render/hittest";
import { compose, IDENTITY, isIdentity, type Pt } from "../render/affine";
import type { Canvas2DRenderer } from "../render/Canvas2DRenderer";
import { applyOptimistic, gestureScene, type Matrix, type PendingPreview } from "./transform";
import {
  CSS_PX_PER_MM, IDENTITY_VIEW, ZOOM_STEP, fitView, minScaleFor, panBy, screenToWorld,
  wheelFactor, zoomAt, type Size, type View,
} from "./viewport";
import { handleAt, selectionBox, type Box, type HandleKind } from "./selectionBox";
import { gestureMatrix, type Modifiers } from "./gesture";
import { marqueeHits, marqueeSelection, normalizeRect, toggleId } from "./marquee";

// CSS px, divided by the view scale at use so they feel the same at every zoom.
const HANDLE_HIT_PX = 6;
const ROTATE_ZONE_PX = 18;
const HIT_TOL_PX = 3;
/** A press that travels less than this is a click: it clears the selection instead of banding. */
const CLICK_SLOP_PX = 3;
/** Some wheels report lines rather than pixels; one line is about one line of text. */
const LINE_PX = 16;

const CURSORS: Record<HandleKind | "pan", string> = {
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  rotate: "crosshair", move: "move", pan: "grab",
};

type Gesture =
  | { t: "pan"; last: Pt } // screen px
  | { t: "transform"; kind: HandleKind; box: Box; ids: number[]; start: Pt; m: Matrix } // world mm
  | { t: "marquee"; start: Pt; cur: Pt; additive: boolean }; // world mm

export type CanvasInteractionArgs = {
  canvasRef: RefObject<HTMLCanvasElement>;
  rendererRef: RefObject<Canvas2DRenderer>;
  scene: Scene;
  selected: number[];
  setSelected: (ids: number[]) => void;
  artboard: Bounds | null;
  /** "refused" puts the preview back. "applied" keeps it even if the snapshot that should follow
   *  failed, because the backend then holds the new geometry and the old scene is the wrong one. */
  commit: (ids: number[], m: Matrix) => Promise<CommitOutcome>;
};

export type CommitOutcome = "applied" | "refused";

type Handlers = {
  onPointerEnter: () => void;
  onPointerDown: (e: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
};

export type CanvasInteraction = {
  view: View;
  size: Size;
  cursor: Pt | null;
  requestFit: () => void;
  /** Draws the scene, selection and any live gesture. App calls it whenever the view, size, scene
   *  or selection changes, so those redraws cannot paint the committed scene over a gesture. */
  repaint: () => void;
  handlers: Handlers;
};

function toCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number): Pt {
  const r = canvas.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

/** The part of `box` under `p` at view scale `scale`, with the CSS-px sizes converted to mm in
 *  one place so the hover cursor and the press cannot disagree about what is under the pointer. */
function handleUnder(box: Box, p: Pt, scale: number): HandleKind | null {
  return handleAt(box, p, HANDLE_HIT_PX / scale, ROTATE_ZONE_PX / scale);
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
}

export function useCanvasInteraction(args: CanvasInteractionArgs): CanvasInteraction {
  const { canvasRef, rendererRef, scene, selected, setSelected, artboard, commit } = args;
  const [view, setViewState] = useState<View>(IDENTITY_VIEW);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  // ponytail: the readout re-renders App on every pointer move. Fine at today's App size; if a
  // profile ever shows it, feed a small readout component from a ref instead of state.
  // Held in screen px and converted on render: a pan or zoom moves the world under a still
  // pointer, and a world position stored at the last move would go stale (Copilot on #298).
  const [cursorScreen, setCursorScreen] = useState<Pt | null>(null);
  const [fitEpoch, setFitEpoch] = useState(0);
  // Native listeners are registered once and pointer handlers run between renders; both read
  // these rather than a render's closure, so they see the selection the user just made.
  const viewRef = useRef(view);
  const latest = useRef({ scene, selected });
  latest.current = { scene, selected };
  const pending = useRef<PendingPreview | null>(null);
  // One transform on the wire at a time. A gesture pressed while a commit is unanswered would build
  // its matrix on that commit's preview, and if the commit were refused it would land about the
  // wrong anchor. The window is one IPC round trip, so a press in it selects but does not drag.
  const inFlight = useRef(false);
  // What gestures start from and what the renderer is put back to: the in-flight preview until a
  // snapshot replaces the scene it was built on, then the committed scene. CodeRabbit on #298.
  const current = () => ({ scene: gestureScene(pending.current, latest.current.scene), selected: latest.current.selected });
  const gesture = useRef<Gesture | null>(null);
  const spaceHeld = useRef(false);
  const overCanvas = useRef(false);
  // Where the pointer last was on screen and which modifiers it held. A gesture follows the
  // document point under the pointer, so a pan or zoom under a still, held pointer must re-derive
  // it from these rather than keep the matrix of the last move (CodeRabbit on #298).
  const lastScreen = useRef<Pt | null>(null);
  const lastMods = useRef<Modifiers>({ shift: false, alt: false });

  const setView = useCallback((v: View) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const requestFit = useCallback(() => setFitEpoch((n) => n + 1), []);
  const minScale = useMemo(
    () => (artboard && size.w > 0 && size.h > 0 ? minScaleFor(artboard, size) : 0),
    [artboard, size],
  );
  const zoomBy = useCallback(
    (screen: Pt, factor: number) => setView(zoomAt(viewRef.current, screen, factor, minScale)),
    [minScale, setView],
  );
  const centre = useCallback((): Pt => ({ x: size.w / 2, y: size.h / 2 }), [size]);

  // The one place the renderer is told what to show. Pointer moves call it, and so does App's
  // effect on any view, size, scene or selection change: a separate redraw from the committed scene
  // painted over a live drag on a mid-gesture pinch, and over the in-flight preview on a selection
  // change (code-reviewer on #298). With no gesture it also puts back a stranded preview.
  const repaint = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    const { scene: s, selected: sel } = current();
    const g = gesture.current;
    if (g?.t === "transform") {
      r.setScene(applyOptimistic(s, g.ids, g.m));
      r.setSelection(g.ids);
      r.setOverlay({ box: { ...g.box, frame: compose(g.box.frame, g.m) }, marquee: null });
    } else {
      r.setScene(s);
      r.setSelection(sel);
      r.setOverlay(
        g?.t === "marquee"
          ? { box: null, marquee: normalizeRect(g.start, g.cur) }
          : { box: selectionBox(s, sel), marquee: null },
      );
    }
    r.draw();
  }, [rendererRef]);

  // Re-derives a live transform or marquee from the pointer under the current view.
  const follow = useCallback(() => {
    const g = gesture.current;
    const screen = lastScreen.current;
    if (!g || g.t === "pan" || !screen) return;
    const p = screenToWorld(viewRef.current, screen);
    gesture.current =
      g.t === "marquee" ? { ...g, cur: p } : { ...g, m: gestureMatrix(g.kind, g.box, g.start, p, lastMods.current) };
  }, []);

  // Declared before App's draw effect runs, so the repaint that follows a view change already
  // draws the re-derived gesture.
  useEffect(() => {
    follow();
  }, [view, follow]);

  // ponytail: devicePixelRatio is read on resize only, so dragging the window from a Retina panel
  // to a 1x one keeps the old backing store until the next resize. Upgrade: a
  // matchMedia(`(resolution: ${dpr}dppx)`) listener that re-runs resize().
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      rendererRef.current?.resize(width, height, window.devicePixelRatio || 1);
      setSize({ w: width, h: height });
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef, rendererRef]);

  // Fit on first layout, on a new artboard (machine switch, project open) and on request. The
  // artboard is compared by its key, not the object: a snapshot rebuilds the object on every
  // edit, and an edit is not a reason to throw away the operator's zoom.
  const artboardKey = artboard ? `${artboard.x},${artboard.y},${artboard.w},${artboard.h}` : null;
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!artboard || size.w === 0 || size.h === 0) return;
    const key = `${artboardKey}#${fitEpoch}`;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    setView(fitView(artboard, size));
  }, [artboardKey, fitEpoch, size, setView]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      // Registered natively because React's wheel listener is passive; without preventDefault the
      // webview scrolls or page-zooms instead of the canvas.
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : 1;
      const screen = toCanvas(canvas, e.clientX, e.clientY);
      setCursorScreen(screen);
      lastScreen.current = screen;
      // WebKit reports a trackpad pinch as a wheel with ctrlKey set, so one branch serves both.
      if (e.ctrlKey || e.metaKey) zoomBy(screen, wheelFactor(e.deltaY * unit));
      else setView(panBy(viewRef.current, -e.deltaX * unit, -e.deltaY * unit));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [canvasRef, setView, zoomBy]);

  useEffect(() => {
    // Keys typed into a field belong to the field. A focused button is different: clicking a tool
    // leaves focus on it, so ignoring buttons outright killed Space-pan after any toolbar click
    // (pr-test-analyzer on #298). Space over the canvas pans, and its keyup is swallowed so the
    // button it would have pressed stays unpressed.
    const onDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.code === "Space") {
        const onButton = e.target instanceof HTMLElement && e.target.tagName === "BUTTON";
        if (onButton && !overCanvas.current) return;
        spaceHeld.current = true;
        e.preventDefault();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "0") requestFit();
      else if (e.key === "1") zoomBy(centre(), CSS_PX_PER_MM / viewRef.current.scale);
      else if (e.key === "=" || e.key === "+") zoomBy(centre(), ZOOM_STEP);
      else if (e.key === "-") zoomBy(centre(), 1 / ZOOM_STEP);
      else return;
      // The webview has its own page zoom on these chords; the canvas zoom replaces it.
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      // A button activates on Space's keyup, not its keydown.
      if (spaceHeld.current) e.preventDefault();
      spaceHeld.current = false;
    };
    // A Space released while another window had focus never arrives here.
    const onBlur = () => {
      spaceHeld.current = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [centre, requestFit, zoomBy]);

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const screen = toCanvas(e.currentTarget, e.clientX, e.clientY);
    lastScreen.current = screen;
    lastMods.current = { shift: e.shiftKey, alt: e.altKey };
    const v = viewRef.current;
    const p = screenToWorld(v, screen);
    if (e.button === 1 || (e.button === 0 && spaceHeld.current)) {
      e.currentTarget.setPointerCapture(e.pointerId);
      gesture.current = { t: "pan", last: screen };
      return;
    }
    if (e.button !== 0) return;
    // Capture replaces SP3's window-level mouseup listener: a drag released outside the canvas
    // still ends here, so its preview is committed instead of stranded.
    e.currentTarget.setPointerCapture(e.pointerId);
    const { scene: s, selected: sel } = current();
    const box = selectionBox(s, sel);
    const kind = box ? handleUnder(box, p, v.scale) : null;
    // Shift-click inside the box toggles the node under the pointer rather than dragging.
    if (box && kind && !(kind === "move" && e.shiftKey)) {
      if (inFlight.current) return;
      gesture.current = { t: "transform", kind, box, ids: sel, start: p, m: IDENTITY };
      return;
    }
    const hit = hitTest(s, p.x, p.y, HIT_TOL_PX / v.scale);
    if (hit === null) {
      gesture.current = { t: "marquee", start: p, cur: p, additive: e.shiftKey };
      return;
    }
    const next = e.shiftKey ? toggleId(sel, hit) : [hit];
    setSelected(next);
    if (inFlight.current) {
      gesture.current = null;
      return;
    }
    // Only drag when the hit node is in the new selection — a Shift-click that toggles a node
    // out must not start dragging the rest.
    const nextBox = next.includes(hit) ? selectionBox(s, next) : null;
    gesture.current = nextBox ? { t: "transform", kind: "move", box: nextBox, ids: next, start: p, m: IDENTITY } : null;
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = e.currentTarget;
    const screen = toCanvas(canvas, e.clientX, e.clientY);
    const v = viewRef.current;
    const p = screenToWorld(v, screen);
    setCursorScreen(screen);
    lastScreen.current = screen;
    lastMods.current = { shift: e.shiftKey, alt: e.altKey };
    const g = gesture.current;
    if (!g) {
      const { scene: s, selected: sel } = current();
      const box = selectionBox(s, sel);
      const kind = spaceHeld.current ? "pan" : box ? handleUnder(box, p, v.scale) : null;
      // ponytail: resize cursors are screen-aligned, so on a rotated box they point along the
      // screen rather than the edge. Upgrade: choose by the handle's on-screen angle.
      canvas.style.cursor = kind ? CURSORS[kind] : "default";
      return;
    }
    if (g.t === "pan") {
      setView(panBy(v, screen.x - g.last.x, screen.y - g.last.y));
      gesture.current = { ...g, last: screen };
      return;
    }
    follow();
    repaint();
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.t === "pan") return;
    if (g.t === "marquee") {
      const travel = Math.hypot(g.cur.x - g.start.x, g.cur.y - g.start.y) * viewRef.current.scale;
      const { scene: s, selected: sel } = current();
      if (travel < CLICK_SLOP_PX) {
        if (!g.additive) setSelected([]);
      } else {
        setSelected(marqueeSelection(sel, marqueeHits(s, normalizeRect(g.start, g.cur)), g.additive));
      }
      // The band is drawn imperatively, and a selection that did not change re-renders nothing.
      repaint();
      return;
    }
    if (isIdentity(g.m)) {
      repaint();
      return;
    }
    pending.current = { base: latest.current.scene, preview: applyOptimistic(current().scene, g.ids, g.m) };
    inFlight.current = true;
    void commit(g.ids, g.m).then((outcome) => {
      inFlight.current = false;
      // Applied but perhaps not re-read (its snapshot can fail): the preview is what the backend now
      // holds, so it stays until a snapshot replaces the scene it was built on.
      if (outcome === "applied") return;
      pending.current = null;
      repaint();
    });
  };

  const onPointerCancel = () => {
    gesture.current = null;
    repaint();
  };

  const onPointerEnter = () => {
    overCanvas.current = true;
  };

  const onPointerLeave = () => {
    overCanvas.current = false;
    setCursorScreen(null);
  };

  return {
    view,
    size,
    cursor: cursorScreen ? screenToWorld(view, cursorScreen) : null,
    requestFit,
    repaint,
    handlers: { onPointerEnter, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onPointerLeave },
  };
}
