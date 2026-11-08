// The forge's canvas size, as the View takes it. The forge sizes the View's canvas
// itself (it never runs the View's own loop), from the canvas's CSS size and the device
// ratio; the View clamps each side of its drawing to the device's largest texture
// (`viewer.maxDrawingSize`, often 4096 or 8192 on WebGL2). A very wide window at a ratio
// of 2 can pass that, and the canvas and the View's drawing would then disagree -- and
// the viewports' rects and the picks with them. So the ratio itself is capped, once, and
// that one ratio is used everywhere a CSS pixel becomes a device pixel.

// The ratio the canvas is drawn at: the device's (`dpr`, the caller's own cap applied),
// lowered so neither side of a `cssWidth` x `cssHeight` canvas passes `maxSize` device
// pixels. A size of none, or no limit (`maxSize` not a positive number: the View not
// made yet), leaves `dpr` as it is.
export function drawingRatio(dpr, cssWidth, cssHeight, maxSize) {
    let r = dpr;
    if (!(maxSize > 0)) return r;
    if (cssWidth > 0) r = Math.min(r, maxSize / cssWidth);
    if (cssHeight > 0) r = Math.min(r, maxSize / cssHeight);
    return r;
}

// One side's drawing size, as the View's `resize` makes it: `css` times `ratio` in f32,
// rounded, then clamped into 1..maxSize as `View::resize` clamps it -- so the canvas's
// backing store is exactly the View's drawing.
export function drawingSide(css, ratio, maxSize) {
    const side = Math.round(Math.fround(Math.fround(css) * Math.fround(ratio)));
    return maxSize > 0 ? Math.min(Math.max(side, 1), maxSize) : Math.max(side, 1);
}
