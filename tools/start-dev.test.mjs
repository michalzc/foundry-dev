import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { activateModule, createWorldRequest, enableBrowserModule, executable, foundryClient, linkPackage, main, port } from './start-dev.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'foundry dev launcher '));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function command(path, source) {
  await writeFile(path, `#!${process.execPath}\n${source}`);
  await chmod(path, 0o755);
}

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

test('discovers executable names and explicit paths, rejecting a missing override', async t => {
  const root = await temporary(t);
  const browser = join(root, 'chromium-browser');
  await command(browser, '');
  assert.equal(await executable(['chromium', 'chromium-browser'], { PATH: root }), browser);
  assert.equal(await executable([browser], { PATH: '' }), browser);
  await assert.rejects(executable([join(root, 'missing')], { PATH: root }), /Executable not found/);
  assert.equal(port(undefined, 9222), 9222);
  for (const value of ['abc', '0', '65536', '1.5']) assert.throws(() => port(value), /Invalid port/);
});

test('system link is repeatable and refuses to replace unrelated data', async t => {
  const root = await temporary(t);
  const build = join(root, 'build');
  const data = join(root, 'data');
  await mkdir(build);
  await linkPackage(data, build, 'system', 'flexible-d6');
  await linkPackage(data, build, 'system', 'flexible-d6');
  const other = join(root, 'other');
  await mkdir(other);
  await assert.rejects(linkPackage(data, other, 'system', 'flexible-d6'), /does not point/);
});

test('Foundry HTTP client preserves cookies and sends same-origin POST requests without following redirects', async t => {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { Location: '/setup', 'Set-Cookie': 'session=test; HttpOnly; SameSite=Strict' });
      res.end();
    } else {
      assert.equal(req.headers.cookie, 'session=test');
      assert.equal(req.headers.origin, `http://${req.headers.host}`);
      assert.equal(req.headers['content-type'], 'application/json');
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = foundryClient(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await request('/')).status, 302);
  assert.equal((await request('/create', { action: 'createWorld' })).status, 200);
});

for (const [packageType, foundryVersion] of [['system', '14.368'], ['module', '14.368'], ['system', '13.351'], ['module', '13.351']]) test(`Foundry ${foundryVersion} ${packageType} session builds, creates/reuses a world, watches, and cleans up`, { timeout: 30000 }, async t => {
  const root = await temporary(t);
  await mkdir(join(root, 'tools'));
  await mkdir(join(root, 'bin'));
  await copyFile(new URL('./start-dev.mjs', import.meta.url), join(root, 'tools', 'start-dev.mjs'));
  await command(join(root, 'bin', 'git'), `console.log(${JSON.stringify(root)});`);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    packageType, packageId: 'example-package', worldId: 'example-world',
    worldTitle: 'Example Development', worldSystem: 'example-system', outputDirectory: 'output with spaces',
    buildCommand: ['npm', 'compile', '--custom'], watchCommand: ['npm', 'watch', '--custom'],
    browserProfile: '.dev/chromium', port: 32000, debugPort: 9222, foundryVersion,
    foundryLauncher: join(root, 'bin', 'start-foundry'),
  }));
  await command(join(root, 'bin', 'npm'), `
const fs = require('node:fs');
fs.appendFileSync('events', process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'watch') setInterval(() => {}, 1000);
else fs.mkdirSync('output with spaces', { recursive: true });
`);
  await command(join(root, 'bin', 'start-foundry'), `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const manifest = path.join(process.env.FOUNDRY_DATA_PATH, 'Data/worlds/example-world/world.json');
let active = Boolean(process.env.FOUNDRY_WORLD) && fs.existsSync(manifest);
fs.appendFileSync('events', 'foundry:' + process.pid + '\\n');
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/status') return res.end(JSON.stringify({active, world: 'example-world', system: 'example-system'}));
  if (req.url === '/') { res.writeHead(302, {Location: active ? '/join' : '/setup'}); return res.end(); }
  if (req.method === 'POST' && req.headers.origin !== 'http://' + req.headers.host) {
    res.writeHead(400); return res.end(JSON.stringify({error: 'The request could not be processed.'}));
  }
  let body = ''; for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  fs.appendFileSync('events', data.action + '\\n');
  if (data.action === 'createWorld') {
    fs.writeFileSync('create-request', JSON.stringify({url: req.url, launch: data.launch ?? null}));
    if (fs.existsSync(manifest)) { res.statusCode = 400; return res.end('{}'); }
    fs.mkdirSync(path.dirname(manifest), {recursive: true});
    fs.writeFileSync(manifest, JSON.stringify({id: data.id, system: data.system, sentinel: 'preserved'}));
  }
  if (data.action === 'launchWorld') active = true;
  res.end('{}');
});
server.listen(Number(process.env.FOUNDRY_PORT), '127.0.0.1');
`);
  await command(join(root, 'bin', 'chromium'), `
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('events', 'chromium:' + process.pid + '\\n');
fs.writeFileSync('browser-args', JSON.stringify(args));
const port = Number(args.find(a => a.startsWith('--remote-debugging-port=')).split('=')[1]);
const url = args.at(-1);
const server = http.createServer((req,res) => {
  const tab = {type:'page', url, webSocketDebuggerUrl:'ws://127.0.0.1:' + port + '/page'};
  res.end(JSON.stringify(req.url === '/json/list' ? [tab] : tab));
});
server.on('upgrade', (req,socket) => {
  const key = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + key + '\\r\\n\\r\\n');
  socket.once('data', () => {
    fs.appendFileSync('events', 'navigate\\n');
    const body = Buffer.from(JSON.stringify({id:1,result:{frameId:'1',result:{value:{state:'ready',active:true}}}}));
    socket.end(Buffer.concat([Buffer.from([129,body.length]),body]));
  });
});
server.listen(port, '127.0.0.1');
`);
  for (let run = 0; run < 2; run++) {
    const child = spawn(process.execPath, [join(root, 'tools', 'start-dev.mjs'), configPath, ...(run === 0 ? ['--watch'] : [])], {
      cwd: tmpdir(),
      env: { ...process.env, PATH: join(root, 'bin'), CHROMIUM_BIN: '', FOUNDRY_WORLD: '',
        FOUNDRY_PORT: String(await unusedPort()), CHROMIUM_DEBUG_PORT: String(await unusedPort()),
        FOUNDRY_DATA_PATH: 'data', FOUNDRY_ADMIN_PASSWORD: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    const deadline = Date.now() + 10000;
    while (!output.includes('World ready:') && child.exitCode === null && Date.now() < deadline) await delay(50);
    assert.match(output, /World ready:/);
    if (run === 0) {
      while (!(await readFile(join(root, 'events'), 'utf8')).includes('watch --custom') && Date.now() < deadline) await delay(20);
    }
    child.kill('SIGTERM');
    assert.equal(await exited, 0, output);
  }
  // A browser startup failure must also shut down the already-started server.
  const brokenBrowser = join(root, 'bin', 'broken-chromium');
  await command(brokenBrowser, 'process.exit(2);');
  const failed = spawn(process.execPath, [join(root, 'tools', 'start-dev.mjs'), configPath], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: join(root, 'bin'), CHROMIUM_BIN: brokenBrowser,
      FOUNDRY_WORLD: '', FOUNDRY_DATA_PATH: 'data',
      FOUNDRY_PORT: String(await unusedPort()), CHROMIUM_DEBUG_PORT: String(await unusedPort()) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (failed.exitCode === null) failed.kill('SIGTERM'); });
  let failureOutput = '';
  failed.stdout.resume();
  failed.stderr.on('data', data => { failureOutput += data; });
  assert.equal(await new Promise(resolve => failed.once('exit', resolve)), 1);
  assert.match(failureOutput, /broken-chromium exited/);
  const events = await readFile(join(root, 'events'), 'utf8');
  assert.equal(events.split('createWorld').length - 1, 1);
  assert.equal(events.split('launchWorld').length - 1, 1);
  assert.equal(events.split('navigate').length - 1, packageType === 'module' ? 4 : 2);
  for (const match of events.matchAll(/(?:foundry|chromium):(\d+)/g)) {
    assert.throws(() => process.kill(Number(match[1]), 0), { code: 'ESRCH' });
  }
  const args = JSON.parse(await readFile(join(root, 'browser-args'), 'utf8'));
  assert.ok(args.includes(`--user-data-dir=${join(root, '.dev', 'chromium')}`));
  assert.equal(await realpath(join(root, 'data', 'Data', `${packageType}s`, 'example-package')), join(root, 'output with spaces'));
  assert.match(events, /compile --custom/);
  assert.match(events, /watch --custom/);
  const manifest = JSON.parse(await readFile(join(root, 'data/Data/worlds/example-world/world.json'), 'utf8'));
  assert.equal(manifest.sentinel, 'preserved');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'create-request'), 'utf8')),
    foundryVersion.startsWith('13.') ? { url: '/setup', launch: null } : { url: '/create', launch: false });
});

const moduleConfig = { packageId: 'example-module', worldId: 'example-world', worldSystem: 'example-system' };
const utils = {
  isNewerVersion: (a, b, { majorOnly = false } = {}) => {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < (majorOnly ? 1 : Math.max(left.length, right.length)); i++) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
    }
    return false;
  },
};

function moduleGame() {
  const module = id => ({ id, active: false, version: '1.0', relationships: { systems: [], requires: [] } });
  let settings = { other: true, disabled: false };
  const writes = [];
  const game = {
    ready: true,
    user: { isGM: true, can: () => true },
    world: { id: 'example-world' },
    system: { id: 'example-system', version: '2.0' },
    modules: new Map(['example-module', 'dependency'].map(id => [id, module(id)])),
    settings: {
      get: () => settings,
      set: async (scope, key, value) => { writes.push({ scope, key, value }); settings = value; },
    },
  };
  return { game, writes };
}

test('module activation includes recursive dependencies and cycles, preserves settings, and is repeatable', async () => {
  const { game, writes } = moduleGame();
  game.modules.get('example-module').relationships.requires = [{ id: 'dependency', type: 'module', compatibility: { minimum: '1', maximum: '1.5' } }];
  game.modules.get('dependency').relationships.requires = [{ id: 'example-module', type: 'module' }];
  assert.deepEqual(await activateModule(moduleConfig, game, utils), { state: 'reload', active: false });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { scope: 'core', key: 'moduleConfiguration', value: { other: true, disabled: false, 'example-module': true, dependency: true } });
  for (const module of game.modules.values()) module.active = true;
  assert.deepEqual(await activateModule(moduleConfig, game, utils), { state: 'ready', active: true });
  assert.equal(writes.length, 1);
});

test('module activation waits for login and refuses wrong worlds or insufficient permissions', async () => {
  const { game, writes } = moduleGame();
  assert.deepEqual(await activateModule(moduleConfig, undefined, utils), { state: 'login' });
  game.ready = false;
  assert.deepEqual(await activateModule(moduleConfig, game, utils), { state: 'login' });
  game.ready = true;
  game.user.isGM = false;
  assert.deepEqual(await activateModule(moduleConfig, game, utils), { state: 'login' });
  game.user.isGM = true;
  game.world.id = 'unrelated';
  await assert.rejects(activateModule(moduleConfig, game, utils), /unexpected world/);
  game.world.id = moduleConfig.worldId;
  game.user.can = () => false;
  await assert.rejects(activateModule(moduleConfig, game, utils), /cannot modify/);
  assert.equal(writes.length, 0);
});

for (const [name, prepare, error] of [
  ['missing project module', game => game.modules.delete('example-module'), /not installed/],
  ['missing dependency', game => { game.modules.get('example-module').relationships.requires = [{ id: 'missing', type: 'module' }]; }, /not installed/],
  ['core incompatibility', game => { game.modules.get('example-module').incompatibleWithCoreVersion = true; }, /incompatible with Foundry/],
  ['wrong system', game => { game.modules.get('example-module').relationships.systems = [{ id: 'another-system' }]; }, /does not support/],
  ['system version', game => { game.modules.get('example-module').relationships.systems = [{ id: moduleConfig.worldSystem, compatibility: { minimum: '3' } }]; }, /requires at least/],
  ['dependency version', game => { game.modules.get('example-module').relationships.requires = [{ id: 'dependency', type: 'module', compatibility: { maximum: '0.5' } }]; }, /supports at most/],
]) test(`module activation refuses ${name} before writing settings`, async () => {
  const { game, writes } = moduleGame();
  prepare(game);
  await assert.rejects(activateModule(moduleConfig, game, utils), error);
  assert.equal(writes.length, 0);
});

// Minimal CDP server which runs the actual serialized browser function.
async function cdpFixture(t, game, transientTab = false) {
  const { createHash } = await import('node:crypto');
  const { runInNewContext } = await import('node:vm');
  const sockets = new Set();
  const methods = [];
  let evaluations = 0;
  const base = 'http://127.0.0.1:32000';
  let lists = 0;
  const server = createServer((_req, res) => res.end(JSON.stringify(transientTab && ++lists === 1 ? [] : [
    { type: 'page', url: `${base}/game`, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` },
  ])));
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on('data', async chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 6 || (buffered[0] & 15) !== 1) return;
      let length = buffered[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 8) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      }
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const body = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      buffered = buffered.subarray(offset + 4 + length);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      const request = JSON.parse(body);
      methods.push(request.method);
      let result = {};
      if (request.method === 'Page.reload') {
        for (const module of game.modules.values()) module.active = game.settings.get()[module.id] === true;
      }
      if (request.method === 'Runtime.evaluate') {
        evaluations++;
        try {
          const value = await runInNewContext(request.params.expression, { game: evaluations === 1 ? undefined : game, foundry: { utils } });
          result = { result: { value } };
        } catch (error) {
          result = { exceptionDetails: { exception: { description: error.message } } };
        }
      }
      const response = Buffer.from(JSON.stringify({ id: request.id, result }));
      const header = Buffer.alloc(response.length < 126 ? 2 : 4);
      header[0] = 129;
      header[1] = response.length < 126 ? response.length : 126;
      if (response.length >= 126) header.writeUInt16BE(response.length, 2);
      socket.write(Buffer.concat([header, response]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { debugPort: server.address().port, base, methods };
}

async function boundedWait(check) {
  for (let i = 0; i < 20; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for GM login and module activation.');
}

test('CDP module startup waits for GM, saves configuration, reloads, and verifies activation', async t => {
  const { game, writes } = moduleGame();
  const { debugPort, base, methods } = await cdpFixture(t, game, true);
  await enableBrowserModule(debugPort, base, moduleConfig, boundedWait);
  assert.equal(writes.length, 1);
  assert.equal(methods.filter(method => method === 'Page.reload').length, 1);
  assert.equal(game.modules.get('example-module').active, true);
});

test('CDP module startup reports browser errors without writing settings', async t => {
  const { game, writes } = moduleGame();
  game.modules.delete('example-module');
  const { debugPort, base } = await cdpFixture(t, game);
  await assert.rejects(enableBrowserModule(debugPort, base, moduleConfig, boundedWait), /not installed/);
  assert.equal(writes.length, 0);
});

test('CDP module startup times out while waiting for GM login', async t => {
  const { game, writes } = moduleGame();
  game.user.isGM = false;
  const { debugPort, base } = await cdpFixture(t, game);
  await assert.rejects(enableBrowserModule(debugPort, base, moduleConfig, boundedWait), /Timed out/);
  assert.equal(writes.length, 0);
});

test('CDP module startup reuses active modules without a setting write or reload', async t => {
  const { game, writes } = moduleGame();
  await game.settings.set('core', 'moduleConfiguration', { other: true, 'example-module': true });
  writes.length = 0;
  game.modules.get('example-module').active = true;
  const { debugPort, base, methods } = await cdpFixture(t, game);
  await enableBrowserModule(debugPort, base, moduleConfig, boundedWait);
  assert.equal(writes.length, 0);
  assert.equal(methods.includes('Page.reload'), false);
});

test('CDP module startup refuses a settings write that does not persist', async t => {
  const { game } = moduleGame();
  game.settings.set = async () => {};
  const { debugPort, base } = await cdpFixture(t, game);
  await assert.rejects(enableBrowserModule(debugPort, base, moduleConfig, boundedWait), /did not persist/);
});


test('automatic setup rejects unsupported Foundry generations before starting processes', async () => {
  for (const foundryVersion of ['12.343', '15.1']) {
    await assert.rejects(main({ foundryVersion }, []), /supports Foundry 13 and 14/);
  }
});

test('world creation uses the generation-specific setup route', () => {
  assert.deepEqual(createWorldRequest(13, 'w', 'W', 's'), ['/setup', { action: 'createWorld', id: 'w', title: 'W', system: 's' }]);
  assert.deepEqual(createWorldRequest(14, 'w', 'W', 's'), ['/create', { action: 'createWorld', id: 'w', title: 'W', system: 's', launch: false }]);
});
