// maximum amount of pages per app (D-pad up/down flips through them)
export const MaxPages: number = 8;

// debounce delay of refreshes
export const RefreshWait: number = 500;

// throttle wait of FocusChangeEvents
export const FocusChangeEventWait: number = 500;

// how long L2 must be held to clear the page (ms)
export const ClearHoldTime: number = 1000;

// an L2 press shorter than this is a tap on the footer hint (touch), which arms clearing (ms)
export const TapMaxDuration: number = 50;

// how long a first tap keeps clearing armed for the confirming second tap (ms)
export const TapToConfirmTimeout: number = 3000;

// button numbers from SteamClient.Input.RegisterForControllerInputMessages (measured on the
// Legion Go S; these raw events also arrive in touch mode, unlike Steam's focus events)
export const RawButtonL1: number = 30;
export const RawButtonL2: number = 28;
export const RawButtonUp: number = 20;
export const RawButtonDown: number = 21;
export const RawButtonLeft: number = 22;
export const RawButtonRight: number = 23;

// width of the canvas pen stroke
export const CanvasStrokeWidth: number = 4;

// width of the canvas eraser
export const CanvasEraserWidth: number = 16;

// color of the pen
export const CanvasStrokeColor: string = "white";

// footer hint colors (text and L1 glyph) for the tool in use, as #rrggbb
export const PencilColor: string = "#59bf40";
export const EraserColor: string = "#ff5a5a";

// background color of the canvas
export const CanvasBackgroundColor: string = "transparent";
