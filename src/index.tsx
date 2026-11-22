/**
 * index.tsx — Notebook: a dotted sketch pad in Quick Access, with separate pages per running game.
 *
 * Fork notes (nroj95/SDH-Notebook):
 * - The canvas fills the panel down to the bottom of the Quick Access window (see paperRef below).
 * - No buttons on top of the paper any more: the page dropdown, pencil/eraser button and trash
 *   button are replaced by controller buttons, so the whole paper below the title line is drawable.
 *   The title line is a Steam Focusable whose actionDescriptionMap makes Steam's own footer show
 *   the hints with real glyphs (the title, not the tall canvas, holds focus so Steam never scrolls
 *   the panel):
 *     D-pad up / down   previous / next page (focus stays on the canvas)
 *     L1                pencil <-> eraser (hint shows the tool in use: green Pencil, red Eraser)
 *     L2 (hold 1 s)     clear page; a ring fills in the middle of the canvas, letting go cancels
 *     tap L2 hint twice touch: the first tap shows a full ring and "Tap again to clear" for 3 s,
 *                       the second clears (a hint tap is a down+up in the same instant)
 * - The title line takes controller focus when the Notebook opens. Paper and canvas both end
 *   exactly at the bottom of the panel.
 *   The presses themselves come from SteamClient's raw controller events, so the first press after
 *   drawing by touch counts too (Steam's focus events would spend it on leaving touch mode).
 * - The title line shows "<game> · Page N of 8 · <last edit | empty>" instead of the dropdown.
 * - Touch-and-hold no longer opens the browser's right-click menu (Back, Forward, Print…).
 * - Strokes are saved right after each stroke, with the page they were drawn on, so flipping pages
 *   quickly can't save one page's drawing onto another.
 *
 * Pages are stored per app id by the Python backend (backend.ts / main.py); the last used page per
 * app is remembered. Touch draws; all other actions are on the controller.
 */
import {
  definePlugin,
  PanelSection,
  ServerAPI,
  staticClasses,
  Router,
  AppOverview,
  Marquee,
  Focusable,
  GamepadButton,
  GamepadEvent,
} from "decky-frontend-lib";
import { VFC, ReactNode, useState, useEffect, useLayoutEffect, useRef } from "react";
import { FaBookOpen, FaTrash } from "react-icons/fa";
import {
  ReactSketchCanvas,
  ReactSketchCanvasRef,
  CanvasPath,
} from "react-sketch-canvas";
import TimeAgo from "react-timeago";
import { debounce, throttle, wrap } from "lodash";

import * as config from "./config";
import * as backend from "./backend";
import background from "../assets/background.svg";

interface FocusChangeEventObject {
  focusedApp: {
    appid: number;
    pid: number;
    strExeName: string;
    windowid: number;
  };
}
declare var SteamClient: {
  System: {
    UI: {
      // careful it's firing a lot in intervals, should be throttled
      RegisterForFocusChangeEvents: (
        cb: (fce: FocusChangeEventObject) => void
      ) => { unregister: () => void };
    };
  };
};

// "5m ago" style age of a page's last edit, or "empty"
const PageAge: VFC<{ timestamp: number }> = ({ timestamp }) =>
  timestamp ? (
    <TimeAgo
      date={timestamp}
      formatter={(value, unit, suffix) => {
        if (suffix === "from now") {
          return "0s ago";
        }
        if (unit === "month") {
          return value + "mo ago";
        }
        return value + unit[0] + " ago";
      }}
    />
  ) : (
    <span>empty</span>
  );

// SVG colour matrix that multiplies by a colour: white becomes the colour, black stays black
const tintMatrix = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3));
  return `${r} 0 0 0 0  0 ${g} 0 0 0  0 0 ${b} 0 0  0 0 0 1 0`;
};
const TINT_ID = "sdh-notebook-tool-tint";

// L1 footer hint: the tool in use, in its colour (green Pencil, red Eraser). Steam draws the button
// glyph itself, as an <img> beside this label, so the label also tints that sibling glyph with the
// colour matrix above (defined inside the label, so it lives in the footer's document) and removes
// the tint again when the hint goes away.
const ToolHint: VFC<{ eraser: boolean }> = ({ eraser }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const color = eraser ? config.EraserColor : config.PencilColor;
  useEffect(() => {
    const glyph = ref.current?.parentElement?.parentElement?.querySelector("img");
    if (!glyph) return;
    glyph.style.filter = `url(#${TINT_ID})`;
    return () => {
      glyph.style.filter = "";
    };
  }, []);
  return (
    <span ref={ref} style={{ color }}>
      <svg width="0" height="0" style={{ position: "absolute" }}>
        <filter id={TINT_ID} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={tintMatrix(color)} />
        </filter>
      </svg>
      {eraser ? "Eraser" : "Pencil"}
    </span>
  );
};

// circumference of the hold-to-clear ring (radius 40)
const RING = 2 * Math.PI * 40;

const Content: VFC<{ serverAPI: ServerAPI }> = ({ serverAPI }) => {
  const sketchCanvasRef = useRef<ReactSketchCanvasRef | null>(null);

  const [runningApp, setRunningApp] = useState<AppOverview | undefined>(
    Router.MainRunningApp
  );
  const [eraserMode, setEraserMode] = useState<boolean>(false);
  const [selectedPage, setSelectedPage] = useState<number>(0);
  // last-edit timestamp per page index, 0 = empty
  const [pageTimes, setPageTimes] = useState<number[]>(
    Array(config.MaxPages).fill(0)
  );
  const [disableState, setDisableState] = useState<boolean>(true);
  // 0..1 while L2 is held for clearing
  const [clearProgress, setClearProgress] = useState<number>(0);
  const holdRef = useRef<{ id: number; view: Window } | null>(null);
  // when the current focus-event press started; a footer-hint tap sends down and up in the same instant
  const pressStartRef = useRef<number>(0);
  // touch: first tap on the hint arms clearing for config.TapToConfirmTimeout, a second tap clears
  const [clearArmed, setClearArmed] = useState<boolean>(false);
  const armTimerRef = useRef<number>(0);
  const focusRef = useRef<HTMLDivElement>(null);
  // whether the Notebook panel is on screen (IntersectionObserver below)
  const visibleRef = useRef<boolean>(false);
  // latest raw-button handler; the Steam listener is registered once and always calls this one
  const rawButtonRef = useRef<(button: number, pressed: boolean) => void>(() => {});

  // The dotted paper and the canvas both end exactly at the bottom of Quick Access's scroll box.
  // Upstream gave the paper "height: 100%" (it starts lower than its container, so it stuck out
  // below and made the panel scrollable: focusing the canvas then scrolled the title line under the
  // header) and the canvas a fixed 19.5rem (Steam Deck-sized; on the Legion Go S the bottom of the
  // paper was undrawable). Positions are measured with offsetTop (layout position: ignores the
  // panel's slide-in animation and the box's scroll), in the canvas's OWN window
  // (ownerDocument.defaultView): plugin code runs in Steam's hidden 1x1 px SharedJSContext.
  // Re-fitted whenever the canvas becomes visible (IntersectionObserver) or that window resizes.
  // Becoming visible also gives the canvas controller focus, so its footer hints show at once.
  const paperRef = useRef<HTMLDivElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const [paperHeight, setPaperHeight] = useState<string>("100%");
  const [canvasHeight, setCanvasHeight] = useState<string>("19.5rem");
  useLayoutEffect(() => {
    const area = canvasAreaRef.current;
    const paper = paperRef.current;
    const view = area?.ownerDocument.defaultView;
    if (!area || !paper || !view) return;
    const docTop = (el: HTMLElement) => {
      let top = 0;
      for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) top += e.offsetTop;
      return top;
    };
    const fit = () => {
      let box = paper.parentElement;
      while (box && !/auto|scroll/.test(view.getComputedStyle(box).overflowY)) box = box.parentElement;
      const bottom = box ? docTop(box) + box.clientHeight : view.innerHeight;
      const canvas = Math.floor(bottom - docTop(area));
      if (canvas < 100) return setCanvasHeight("19.5rem"); // implausible layout: keep the original size
      setPaperHeight(`${Math.floor(bottom - docTop(paper))}px`);
      setCanvasHeight(`${canvas}px`);
    };
    fit();
    const visibility = new view.IntersectionObserver(entries => {
      visibleRef.current = entries.some(e => e.isIntersecting);
      if (!visibleRef.current) return;
      fit();
      focusRef.current?.focus();
    });
    visibility.observe(area);
    view.addEventListener("resize", fit);
    return () => { visibility.disconnect(); view.removeEventListener("resize", fit); };
  }, []);

  const toastError = (e: any) => {
    serverAPI.toaster.toast({
      title: "Notebook Error",
      body: String(e),
      critical: true,
      duration: 30000,
      icon: <FaBookOpen />,
    });
  };

  const loadPage = async (
    appid: number,
    page: number
  ): Promise<CanvasPath[]> => {
    let p: backend.Page;
    try {
      p = await backend.loadPage(appid, page);
    } catch (e) {
      toastError(e);
      return [];
    }
    if (p.empty || !p.data?.length) return [];
    try {
      return JSON.parse(p.data) as CanvasPath[];
    } catch (e) {
      console.error(e);
      toastError(e);
    }
    return [];
  };

  const savePage = async (
    appid: number,
    page: number,
    data: CanvasPath[]
  ): Promise<number> => {
    const jsonData = data.length > 0 ? JSON.stringify(data) : "";
    try {
      return (await backend.savePage(appid, page, jsonData)).timestamp;
    } catch (e) {
      toastError(e);
      return 0;
    }
  };

  const deletePage = async (appid: number, page: number): Promise<boolean> => {
    try {
      return await backend.deletePage(appid, page);
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  const saveLastSelectedPage = async (
    appid: number,
    page: number
  ): Promise<boolean> => {
    try {
      return await backend.saveLastSelectedPage(appid, page);
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  const loadLastSelectedPage = async (appid: number): Promise<number> => {
    try {
      return await backend.loadLastSelectedPage(appid);
    } catch (e) {
      toastError(e);
      return 0;
    }
  };

  const listPages = async (appid: number): Promise<backend.Page[]> => {
    try {
      return await backend.listPages(appid);
    } catch (e) {
      toastError(e);
      return [];
    }
  };

  const setPageTime = (page: number, timestamp: number) =>
    setPageTimes((times) => times.map((t, i) => (i === page ? timestamp : t)));

  const refresh = debounce(
    wrap(
      async () => {
        setRunningApp(Router.MainRunningApp);
        const appid = Number(Router.MainRunningApp?.appid || 0);
        const bPages = await listPages(appid);
        const lastSelectedPage = await loadLastSelectedPage(appid);
        setPageTimes(
          Array.from({ length: config.MaxPages }, (_, i) => {
            const p = bPages.find((p) => p.page === i);
            return !p?.empty && p?.timestamp ? p.timestamp : 0;
          })
        );
        setSelectedPage(lastSelectedPage);
        sketchCanvasRef.current?.resetCanvas();
        const canvasPaths = await loadPage(appid, lastSelectedPage);
        sketchCanvasRef.current?.loadPaths(canvasPaths);
      },
      (f) => {
        // wrap with disabled state
        setDisableState(true);
        return f().finally(() => setDisableState(false));
      }
    ),
    config.RefreshWait,
    { leading: true, trailing: false }
  );

  // called when the ref is ready
  const sketchCanvasRefCallback = (ref: ReactSketchCanvasRef) => {
    if (!ref) return;
    sketchCanvasRef.current = ref;
    ref.eraseMode(eraserMode);
  };

  useEffect(() => {
    let runningAppPid: number = 0;
    const { unregister } = SteamClient.System.UI.RegisterForFocusChangeEvents(
      throttle(async (fce: FocusChangeEventObject) => {
        if (
          runningAppPid === fce.focusedApp?.pid ||
          fce.focusedApp?.appid === Number(runningApp?.appid || 0)
        ) {
          return;
        }
        runningAppPid = fce.focusedApp?.pid;
        await refresh();
      }, config.FocusChangeEventWait)
    );
    refresh();
    return () => {
      unregister();
      stopHold();
      clearTimeout(armTimerRef.current);
    };
  }, []);

  const changePage = async (page: number) => {
    if (disableState || page < 0 || page >= config.MaxPages || page === selectedPage) return;
    disarmClear(); // an armed clear belongs to the page it was armed on
    setDisableState(true);
    try {
      const appid = Number(Router.MainRunningApp?.appid || 0);
      setSelectedPage(page);
      saveLastSelectedPage(appid, page);
      sketchCanvasRef.current?.resetCanvas();
      const canvasPaths = await loadPage(appid, page);
      sketchCanvasRef.current?.loadPaths(canvasPaths);
    } finally {
      setDisableState(false);
    }
  };

  const toggleEraser = () => {
    setEraserMode(!eraserMode);
    sketchCanvasRef.current?.eraseMode(!eraserMode);
  };

  const disarmClear = () => {
    clearTimeout(armTimerRef.current);
    setClearArmed(false);
  };

  const clearPage = async () => {
    disarmClear();
    const appid = Number(Router.MainRunningApp?.appid || 0);
    const page = selectedPage;
    sketchCanvasRef.current?.resetCanvas();
    if (await deletePage(appid, page)) setPageTime(page, 0);
  };

  // L2 held: fill the ring over config.ClearHoldTime, then clear; animated in the canvas's own window
  const startHold = () => {
    const view = canvasAreaRef.current?.ownerDocument.defaultView;
    if (disableState || holdRef.current || !view) return;
    const start = view.performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / config.ClearHoldTime);
      setClearProgress(progress);
      if (progress >= 1) {
        holdRef.current = null;
        setClearProgress(0);
        clearPage();
        return;
      }
      holdRef.current = { id: view.requestAnimationFrame(tick), view };
    };
    holdRef.current = { id: view.requestAnimationFrame(tick), view };
  };

  const stopHold = () => {
    if (holdRef.current) holdRef.current.view.cancelAnimationFrame(holdRef.current.id);
    holdRef.current = null;
    setClearProgress(0);
  };

  const isPageButton = (button: number) =>
    button === GamepadButton.DIR_UP || button === GamepadButton.DIR_DOWN;

  // Real button presses are handled from SteamClient's raw controller events: after a touch, Steam
  // spends the first press on switching back to controller mode, so that press never reaches the
  // Focusable. Raw presses count only while the Notebook is on screen and either nothing has
  // controller focus (touch mode) or the Notebook does, so D-pad use elsewhere in Quick Access
  // (e.g. on the tab icons) doesn't flip pages.
  rawButtonRef.current = (button, pressed) => {
    const doc = focusRef.current?.ownerDocument;
    if (!visibleRef.current || doc?.visibilityState !== "visible") return;
    const focused = doc.querySelector(".gpfocus");
    if (focused && !focusRef.current?.contains(focused)) return;
    if (button === config.RawButtonL2) return pressed ? startHold() : stopHold();
    if (!pressed) return;
    if (button === config.RawButtonL1) toggleEraser();
    else if (button === config.RawButtonUp) changePage(selectedPage - 1);
    else if (button === config.RawButtonDown) changePage(selectedPage + 1);
  };
  useEffect(() => {
    const reg = (globalThis as any).SteamClient.Input.RegisterForControllerInputMessages(
      (_controller: number, button: number, pressed: boolean) => rawButtonRef.current(button, pressed)
    );
    return () => reg.unregister();
  }, []);

  // Steam's focus events for the same buttons only stop Steam acting on them (up/down would move
  // focus away), since the raw events above already did the work. Exception: tapping a footer hint
  // sends no raw event, just a Focusable down+up in the same instant (no finger is that fast);
  // such taps do the hint's action, and for L2 arm, then confirm, clearing.
  const ownButtons: number[] = [
    GamepadButton.DIR_UP,
    GamepadButton.DIR_DOWN,
    GamepadButton.BUMPER_LEFT,
    GamepadButton.TRIGGER_LEFT,
  ];

  const handleButtonDown = (evt: GamepadEvent) => {
    if (!ownButtons.includes(evt.detail.button)) return;
    pressStartRef.current = performance.now();
    evt.preventDefault();
    evt.stopPropagation();
  };

  const handleButtonUp = (evt: GamepadEvent) => {
    const { button } = evt.detail;
    if (!ownButtons.includes(button)) return;
    if (performance.now() - pressStartRef.current > config.TapMaxDuration) return;
    if (button === GamepadButton.BUMPER_LEFT) return toggleEraser();
    if (isPageButton(button))
      return void changePage(selectedPage + (button === GamepadButton.DIR_DOWN ? 1 : -1));
    if (clearArmed) return void clearPage();
    setClearArmed(true);
    clearTimeout(armTimerRef.current);
    armTimerRef.current = window.setTimeout(() => setClearArmed(false), config.TapToConfirmTimeout);
  };

  // up/down flip pages, so they must not also move focus away from the canvas
  const handleGamepadDirection = (evt: GamepadEvent) => {
    if (!isPageButton(evt.detail.button)) return;
    evt.preventDefault();
    evt.stopPropagation();
  };

  // footer hints, shown by Steam with its own glyphs while the Notebook (its title line) has focus
  const actions: { [key in GamepadButton]?: ReactNode } = {
    [GamepadButton.BUMPER_LEFT]: <ToolHint eraser={eraserMode} />,
    [GamepadButton.TRIGGER_LEFT]: clearArmed ? "Tap again to clear" : "Hold to clear page",
  };
  if (selectedPage > 0) actions[GamepadButton.DIR_UP] = "Previous page";
  if (selectedPage < config.MaxPages - 1) actions[GamepadButton.DIR_DOWN] = "Next page";

  // saves each stroke right away, together with the page it was drawn on
  const handleCanvasStroke = async (_path: CanvasPath, _isEraser: boolean) => {
    const appid = Number(Router.MainRunningApp?.appid || 0);
    const page = selectedPage;
    const canvasPaths = await sketchCanvasRef.current?.exportPaths();
    const timestamp = await savePage(appid, page, canvasPaths || []);
    setPageTime(page, timestamp);
  };

  return (
    <div
      ref={paperRef}
      // a long touch counts as a right-click, which opened the browser menu (Back, Forward, Print…)
      onContextMenu={(e) => e.preventDefault()}
      style={{
        height: paperHeight,
        margin: "-0.4rem",
        overflow: "hidden",
        backgroundImage: `url(${background})`,
        backgroundPosition: "center",
      }}
    >
      <PanelSection>
        {/* The title line holds controller focus (and so the buttons and footer hints): Steam
            scrolls the focused element into view, and Decky's panel wrapper is taller than the
            window, so a focused canvas would nudge the panel down; the title line keeps it at the top. */}
        <Focusable
          ref={focusRef}
          {...({ focusable: true } as {})}
          noFocusRing={true}
          actionDescriptionMap={actions}
          onButtonDown={handleButtonDown}
          onButtonUp={handleButtonUp}
          onGamepadDirection={handleGamepadDirection}
          onGamepadBlur={stopHold}
        >
          <Marquee>
            {`${runningApp?.display_name || "Steam"} · Page ${selectedPage + 1} of ${config.MaxPages} · `}
            <PageAge timestamp={pageTimes[selectedPage]} />
          </Marquee>
        </Focusable>
        <div ref={canvasAreaRef} style={{ marginTop: "0.5rem", position: "relative" }}>
          <ReactSketchCanvas
            ref={sketchCanvasRefCallback}
            strokeColor={config.CanvasStrokeColor}
            canvasColor={config.CanvasBackgroundColor}
            strokeWidth={config.CanvasStrokeWidth}
            eraserWidth={config.CanvasEraserWidth}
            height={canvasHeight}
            style={{ zIndex: 0 }}
            onStroke={handleCanvasStroke}
          />
          {(clearProgress > 0 || clearArmed) && (
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "40%",
                transform: "translate(-50%, -50%)",
                width: 96,
                height: 96,
                zIndex: 1,
                pointerEvents: "none",
              }}
            >
              <svg width="96" height="96" viewBox="0 0 96 96">
                <circle cx="48" cy="48" r="40" fill="rgba(0,0,0,0.6)" stroke="rgba(255,255,255,0.2)" strokeWidth="6" />
                <circle
                  cx="48"
                  cy="48"
                  r="40"
                  fill="none"
                  stroke="#ff5a5a"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={RING}
                  strokeDashoffset={clearArmed ? 0 : RING * (1 - clearProgress)}
                  transform="rotate(-90 48 48)"
                />
              </svg>
              <FaTrash
                size={28}
                color="white"
                style={{ position: "absolute", left: 34, top: 34 }}
              />
            </div>
          )}
        </div>
      </PanelSection>
    </div>
  );
};

export default definePlugin((serverApi: ServerAPI) => {
  backend.setServerAPI(serverApi);

  return {
    title: <div className={staticClasses.Title}>Notebook</div>,
    content: <Content serverAPI={serverApi} />,
    icon: <FaBookOpen />,
    onDismount() {},
  };
});
