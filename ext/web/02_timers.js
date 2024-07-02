// Copyright 2018-2024 the Deno authors. All rights reserved. MIT license.

import { core, primordials } from "ext:core/mod.js";
import { op_defer, op_now } from "ext:core/ops";
const {
  Uint8Array,
  Uint32Array,
  PromisePrototypeThen,
  TypedArrayPrototypeGetBuffer,
  TypeError,
  indirectEval,
  ReflectApply,
} = primordials;

import * as webidl from "ext:deno_webidl/00_webidl.js";

const hrU8 = new Uint8Array(8);
const hr = new Uint32Array(TypedArrayPrototypeGetBuffer(hrU8));
function opNow() {
  op_now(hrU8);
  return (hr[0] * 1000 + hr[1] / 1e6);
}

// ---------------------------------------------------------------------------

function checkThis(thisArg) {
  if (thisArg !== null && thisArg !== undefined && thisArg !== globalThis) {
    throw new TypeError("Illegal invocation");
  }
}

/**
 * Call a callback function immediately.
 */
function setImmediate(callback, ...args) {
  if (args.length > 0) {
    const unboundCallback = callback;
    callback = () => ReflectApply(unboundCallback, window, args);
  }

  return core.queueImmediate(
    callback,
  );
}

/**
 * Call a callback function after a delay.
 */
function setTimeout(callback, timeout = 0, ...args) {
  checkThis(this);
  const snapshot = core.AsyncContext.snapshot();
  // If callback is a string, replace it with a function that evals the string on every timeout
  if (typeof callback !== "function") {
    const unboundCallback = webidl.converters.DOMString(callback);
    callback = () => {
      const old = core.AsyncContext.swap(snapshot);
      try {
        indirectEval(unboundCallback);
      } finally {
        core.AsyncContext.swap(old);
      }
    };
  }
  if (args.length > 0) {
    const unboundCallback = callback;
    callback = () => {
      const old = core.AsyncContext.swap(snapshot);
      try {
        ReflectApply(unboundCallback, window, args);
      } finally {
        core.AsyncContext.swap(old);
      }
    };
  }
  timeout = webidl.converters.long(timeout);
  return core.queueUserTimer(
    core.getTimerDepth() + 1,
    false,
    timeout,
    callback,
  );
}

/**
 * Call a callback function after a delay.
 */
function setInterval(callback, timeout = 0, ...args) {
  checkThis(this);
  const snapshot = core.AsyncContext.snapshot();
  if (typeof callback !== "function") {
    const unboundCallback = webidl.converters.DOMString(callback);
    callback = () => {
      const old = core.AsyncContext.swap(snapshot);
      try {
        indirectEval(unboundCallback);
      } finally {
        core.AsyncContext.swap(old);
      }
    };
  }
  if (args.length > 0) {
    const unboundCallback = callback;
    callback = () => {
      const old = core.AsyncContext.swap(snapshot);
      try {
        ReflectApply(unboundCallback, window, args);
      } finally {
        core.AsyncContext.swap(old);
      }
    };
  }
  timeout = webidl.converters.long(timeout);
  return core.queueUserTimer(
    core.getTimerDepth() + 1,
    true,
    timeout,
    callback,
  );
}

/**
 * Clear a timeout or interval.
 */
function clearTimeout(id = 0) {
  checkThis(this);
  id = webidl.converters.long(id);
  core.cancelTimer(id);
}

/**
 * Clear a timeout or interval.
 */
function clearInterval(id = 0) {
  checkThis(this);
  id = webidl.converters.long(id);
  core.cancelTimer(id);
}

/**
 * Mark a timer as not blocking event loop exit.
 */
function unrefTimer(id) {
  core.unrefTimer(id);
}

/**
 * Mark a timer as blocking event loop exit.
 */
function refTimer(id) {
  core.refTimer(id);
}

// Defer to avoid starving the event loop. Not using queueMicrotask()
// for that reason: it lets promises make forward progress but can
// still starve other parts of the event loop.
function defer(go) {
  PromisePrototypeThen(op_defer(), () => go());
}

export {
  clearInterval,
  clearTimeout,
  defer,
  opNow,
  refTimer,
  setImmediate,
  setInterval,
  setTimeout,
  unrefTimer,
};
