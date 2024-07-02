// Copyright 2018-2024 the Deno authors. All rights reserved. MIT license.
// Copyright Joyent and Node contributors. All rights reserved. MIT license.

// TODO(petamoriken): enable prefer-primordials for node polyfills
// deno-lint-ignore-file prefer-primordials

import { core, primordials } from "ext:core/mod.js";
import { validateFunction } from "ext:deno_node/internal/validators.mjs";
import { newAsyncId } from "ext:deno_node/internal/async_hooks.ts";

const { AsyncContext } = core;
const { ObjectDefineProperties, ReflectApply } = primordials;

export class AsyncResource {
  type: string;
  #snapshot;
  #asyncId: number;

  constructor(type: string) {
    this.type = type;
    this.#snapshot = AsyncContext.snapshot();
    this.#asyncId = newAsyncId();
  }

  asyncId() {
    return this.#asyncId;
  }

  runInAsyncScope(
    fn: (...args: unknown[]) => unknown,
    thisArg: unknown,
    ...args: unknown[]
  ) {
    const oldContext = AsyncContext.swap(this.#snapshot);
    try {
      return ReflectApply(fn, thisArg, args);
    } finally {
      AsyncContext.swap(oldContext);
    }
  }

  emitDestroy() {}

  bind(fn: (...args: unknown[]) => unknown, thisArg = this) {
    validateFunction(fn, "fn");
    const snapshot = AsyncContext.snapshot();

    const bound = function (...args: unknown[]) {
      const oldContext = AsyncContext.swap(snapshot);
      try {
        return ReflectApply(fn, thisArg, args);
      } finally {
        AsyncContext.swap(oldContext);
      }
    };

    ObjectDefineProperties(bound, {
      "name": {
        configurable: true,
        enumerable: false,
        value: fn.name,
        writable: false,
      },
      "length": {
        configurable: true,
        enumerable: false,
        value: fn.length,
        writable: false,
      },
    });

    return bound;
  }

  static bind(
    fn: (...args: unknown[]) => unknown,
    type?: string,
    thisArg?: AsyncResource,
  ) {
    type = type || fn.name || "AsyncResource";
    return (new AsyncResource(type)).bind(fn, thisArg);
  }
}

export class AsyncLocalStorage {
  #instance;

  constructor() {
    this.#instance = new AsyncContext();
  }

  // deno-lint-ignore no-explicit-any
  run(store: any, callback: any, ...args: any[]): any {
    return this.#instance.run(store, callback, args);
  }

  // deno-lint-ignore no-explicit-any
  exit(callback: (...args: unknown[]) => any, ...args: any[]): any {
    if (!this.#instance.enabled) {
      return ReflectApply(callback, undefined, args);
    }
    this.#instance.enabled = false;
    try {
      return ReflectApply(callback, undefined, args);
    } finally {
      this.#instance.enabled = true;
    }
  }

  // deno-lint-ignore no-explicit-any
  getStore(): any {
    return this.#instance.get();
  }

  enterWith(store: unknown) {
    this.#instance.enter(store);
  }

  disable() {
    this.#instance.disable();
  }

  static bind(fn: (...args: unknown[]) => unknown) {
    return AsyncResource.bind(fn);
  }

  static snapshot() {
    return AsyncLocalStorage.bind((
      cb: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => ReflectApply(cb, undefined, args));
  }
}

export function executionAsyncId() {
  return 1;
}

class AsyncHook {
  enable() {
  }

  disable() {
  }
}

export function createHook() {
  return new AsyncHook();
}

// Placing all exports down here because the exported classes won't export
// otherwise.
export default {
  // Embedder API
  AsyncResource,
  executionAsyncId,
  createHook,
  AsyncLocalStorage,
};
