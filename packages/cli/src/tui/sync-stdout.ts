/** BSU/ESU synchronized-update stdout proxy (phase 3c Task 1). Wrapping every `write()` in
 *  `\x1b[?2026h ... \x1b[?2026l` ("begin/end synchronized update") tells a terminal that understands
 *  the mode to buffer the whole chunk and paint it as one atomic frame — exactly what a fullscreen
 *  Ink app wants, since Ink's own render pass writes a complete frame (clear + repaint) per call and
 *  an unsynchronized terminal can paint that mid-write, causing a visible partial-frame flash. A
 *  terminal that doesn't understand mode 2026 just ignores the two escapes as no-ops (DEC private
 *  modes are safely ignorable-if-unknown by spec), so this is a pure improvement with no fallback
 *  branch needed.
 *
 *  Every OTHER property Ink touches on stdout — `columns`, `rows`, `isTTY`, `on`/`off` (Ink's own
 *  constructor does `stdout.on('resize', this.resized)`), `emit`, etc. — must forward to the REAL
 *  stream, live (not a snapshot taken at proxy-creation time), since Ink reads `columns`/`rows` fresh
 *  on every layout pass and needs 'resize' events delivered to the ACTUAL underlying stream object.
 *
 *  Implementation note — Proxy vs. a plain delegating object: the interface needs to satisfy the full
 *  `NodeJS.WriteStream` shape (dozens of members: `cursorTo`, `clearLine`, `getColorDepth`, the whole
 *  Writable/EventEmitter surface, ...) without hand-enumerating all of them, so a `Proxy` around the
 *  real stream is the right shape. But the naive "transparent forwarding" pattern often shown for
 *  Proxies — `get(target, prop, receiver) { return Reflect.get(target, prop, receiver) }` — is
 *  UNSOUND here: passing `receiver` (the proxy itself) through means any accessor or method that
 *  Node/Bun implements using genuine ES private class fields (`#foo`) runs with `this` bound to the
 *  PROXY, not the real stream instance — and private-field access is brand-checked per-object, not
 *  looked up via the prototype chain, so it throws `TypeError: Cannot read private member ... from an
 *  object whose class did not declare it` the moment such a method/getter is invoked through the
 *  proxy. Verified empirically (both Bun and Node) against a minimal class using a `#private` field
 *  in its `write()`: the `Reflect.get(target, prop, receiver)` pattern throws exactly that error;
 *  binding methods to `target` (not `receiver`) and reading data properties directly off `target`
 *  does not. So below: getters/data props are read straight off `real` (implicit receiver = real,
 *  never the proxy), and any function value is returned pre-bound to `real` — this sidesteps the
 *  whole private-field/this-identity hazard regardless of whether Node's or Bun's actual
 *  `tty.WriteStream` internals happen to use private fields in the exact members Ink touches (a
 *  version-dependent detail not worth gambling on). */

export function makeSyncStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  const wrappedWrite = (
    chunk: unknown,
    encodingOrCallback?: unknown,
    callback?: unknown,
  ): boolean => {
    if (typeof chunk !== "string") {
      // Non-string (Buffer/Uint8Array) chunks pass through unwrapped — BSU/ESU only makes sense
      // around a text frame, and Ink only ever writes strings (verified in ink.js/log-update.js).
      return (real.write as (...a: unknown[]) => boolean)(chunk, encodingOrCallback, callback);
    }
    const wrapped = "\x1b[?2026h" + chunk + "\x1b[?2026l";
    if (typeof encodingOrCallback === "function") {
      // write(chunk, callback) form — encodingOrCallback IS the callback; don't pass it twice.
      return (real.write as (...a: unknown[]) => boolean)(wrapped, encodingOrCallback);
    }
    return (real.write as (...a: unknown[]) => boolean)(wrapped, encodingOrCallback, callback);
  };

  return new Proxy(real, {
    get(target, prop, _receiver) {
      if (prop === "write") return wrappedWrite;
      const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      (target as unknown as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  }) as NodeJS.WriteStream;
}
