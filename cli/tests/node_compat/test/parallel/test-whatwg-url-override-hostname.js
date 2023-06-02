// deno-fmt-ignore-file
// deno-lint-ignore-file

// Copyright Joyent and Node contributors. All rights reserved. MIT license.
// Taken from Node 18.12.1
// This file is automatically generated by `tools/node_compat/setup.ts`. Do not modify this file manually.

'use strict';

require('../common');
const assert = require('assert');

{
  const url = new (class extends URL { get hostname() { return 'bar.com'; } })('http://foo.com/');
  assert.strictEqual(url.href, 'http://foo.com/');
  assert.strictEqual(url.toString(), 'http://foo.com/');
  assert.strictEqual(url.toJSON(), 'http://foo.com/');
  assert.strictEqual(url.hash, '');
  assert.strictEqual(url.host, 'foo.com');
  assert.strictEqual(url.hostname, 'bar.com');
  assert.strictEqual(url.origin, 'http://foo.com');
  assert.strictEqual(url.password, '');
  assert.strictEqual(url.protocol, 'http:');
  assert.strictEqual(url.username, '');
  assert.strictEqual(url.search, '');
  assert.strictEqual(url.searchParams.toString(), '');
}
