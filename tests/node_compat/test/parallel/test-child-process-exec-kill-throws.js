// deno-fmt-ignore-file
// deno-lint-ignore-file

// Copyright Joyent and Node contributors. All rights reserved. MIT license.
// Taken from Node 18.8.0
// This file is automatically generated by "node/_tools/setup.ts". Do not modify this file manually

// TODO(PolarETech): The process.argv[3] check should be argv[2], and the
// command passed to exec() should not need to include "run", "-A",
// and "runner.ts".

'use strict';
// Flags: --expose-internals
const common = require('../common');
const assert = require('assert');
const cp = require('child_process');

if (process.argv[3] === 'child') {
  // Since maxBuffer is 0, this should trigger an error.
  console.log('foo');
} else {
  const internalCp = require('internal/child_process');

  // Monkey patch ChildProcess#kill() to kill the process and then throw.
  const kill = internalCp.ChildProcess.prototype.kill;

  internalCp.ChildProcess.prototype.kill = function() {
    kill.apply(this, arguments);
    throw new Error('mock error');
  };

  const cmd = `"${process.execPath}" run -A runner.ts "${__filename}" child`;
  const options = { maxBuffer: 0, killSignal: 'SIGKILL' };

  const child = cp.exec(cmd, options, common.mustCall((err, stdout, stderr) => {
    // Verify that if ChildProcess#kill() throws, the error is reported.
    assert.strictEqual(err.message, 'mock error', err);
    assert.strictEqual(stdout, '');
    assert.strictEqual(stderr, '');
    assert.strictEqual(child.killed, true);
  }));
}
