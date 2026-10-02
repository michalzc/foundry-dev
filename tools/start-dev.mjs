import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import net from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const runFile = promisify(execFile);

export async function repositoryRoot(git = 'git') {
  try {
    const { stdout } = await runFile(git, ['rev-parse', '--show-toplevel']);
    return stdout.trimEnd();
  } catch {
    throw new Error('Run start-dev inside the project Git checkout.');
  }
}

export async function executable(names, env = process.env) {
  for (const name of names) {
    const candidates = name.includes('/') ? [resolve(name)]
      : (env.PATH ?? '').split(delimiter).map(dir => resolve(dir, name));
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch { /* Try the next executable. */ }
    }
  }
  throw new Error(`Executable not found: ${names.join(' or ')}`);
}

export function port(value, fallback) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1024 || result > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return result;
}

export async function linkPackage(dataPath, buildPath, type, id) {
  const destination = join(dataPath, 'Data', `${type}s`, id);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await symlink(buildPath, destination, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await realpath(destination) !== await realpath(buildPath)) {
      throw new Error(`Package path does not point to this build: ${destination}`, { cause: error });
    }
  }
}

async function freePort(number) {
  const server = net.createServer();
  await new Promise((accept, reject) => {
    server.once('error', () => reject(new Error(`Port ${number} is occupied. Stop the existing instance or choose another port.`)));
    server.listen(number, '127.0.0.1', accept);
  });
  await new Promise(accept => server.close(accept));
}

export function foundryClient(base) {
  let cookie = '';
  return async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      // Foundry 14 rejects POST requests without a matching Origin.
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', Origin: new URL(base).origin } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    const session = response.headers.getSetCookie().find(value => value.startsWith('session='));
    if (session) cookie = session.split(';')[0];
    return response;
  };
}

export async function browserCall(debugPort, base, method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(5000) });
  const tabs = await response.json();
  const tab = tabs.find(tab => tab.type === 'page' && (tab.url === base || tab.url.startsWith(`${base}/`)));
  if (!tab?.webSocketDebuggerUrl) throw new Error(`Foundry tab not found. Open ${base}/join in Chromium.`);
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  return new Promise((accept, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else accept(result);
    };
    const timer = setTimeout(() => finish(new Error('Browser command timed out.')), 10000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { return finish(new Error('Invalid browser response.')); }
      if (message.id !== 1) return;
      const error = message.error?.message || message.result?.errorText;
      finish(error ? new Error(`Browser command failed: ${error}`) : null, message.result);
    });
    socket.addEventListener('error', () => finish(new Error('Browser command failed.')), { once: true });
    socket.addEventListener('close', () => finish(new Error('Browser connection closed.')), { once: true });
  });
}

// Serialized into the browser; keep all dependencies in the arguments.
export async function activateModule(config, clientGame, utils) {
  if (!clientGame?.ready || !clientGame.user?.isGM) return { state: 'login' };
  if (clientGame.world.id !== config.worldId || clientGame.system.id !== config.worldSystem) {
    throw new Error('Module activation refused: unexpected world or system.');
  }
  if (!clientGame.user.can('SETTINGS_MODIFY')) throw new Error('GM cannot modify world settings.');
  const current = clientGame.settings.get('core', 'moduleConfiguration');
  const next = { ...current };
  const visited = new Set();
  function compatible(version, bounds, name, majorMaximum = false) {
    if (bounds?.minimum && utils.isNewerVersion(bounds.minimum, version)) {
      throw new Error(`${name} requires at least ${bounds.minimum}; installed: ${version}.`);
    }
    if (bounds?.maximum && utils.isNewerVersion(version, bounds.maximum,
      { majorOnly: majorMaximum && Number.isInteger(Number(bounds.maximum)) })) {
      throw new Error(`${name} supports at most ${bounds.maximum}; installed: ${version}.`);
    }
  }
  function visit(id) {
    if (visited.has(id)) return;
    const module = clientGame.modules.get(id);
    if (!module) throw new Error(`Required module is not installed or compatible: ${id}.`);
    if (module.incompatibleWithCoreVersion) throw new Error(`Module ${id} is incompatible with Foundry.`);
    visited.add(id);
    const systems = Array.from(module.relationships.systems ?? []);
    const supported = systems.find(system => system.id === config.worldSystem);
    if (systems.length && !supported) throw new Error(`Module ${id} does not support ${config.worldSystem}.`);
    compatible(clientGame.system.version, supported?.compatibility, `Module ${id} / system`, true);
    for (const dependency of module.relationships.requires ?? []) {
      if (dependency.type && dependency.type !== 'module') continue;
      const installed = clientGame.modules.get(dependency.id);
      if (!installed) throw new Error(`Required module is not installed: ${dependency.id} (required by ${id}).`);
      compatible(installed.version, dependency.compatibility, `Module ${dependency.id}`);
      visit(dependency.id);
    }
    next[id] = true;
  }
  visit(config.packageId);
  const changed = [...visited].some(id => current[id] !== true);
  if (changed) await clientGame.settings.set('core', 'moduleConfiguration', next);
  return { state: changed ? 'reload' : 'ready', active: [...visited].every(id => clientGame.modules.get(id).active) };
}

export async function enableBrowserModule(debugPort, base, config, waitFor) {
  console.log('Join the development world as GM in Chromium to enable the project module.');
  let reloaded = false;
  await waitFor(async () => {
    const expression = `(${activateModule.toString()})(${JSON.stringify(config)}, typeof game === 'undefined' ? undefined : game, typeof foundry === 'undefined' ? undefined : foundry.utils)`;
    let result;
    try {
      result = await browserCall(debugPort, base, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    } catch (error) {
      if (/Execution context was destroyed|Cannot find context|Foundry tab not found/.test(error.message)) return false;
      throw error;
    }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    const status = result.result?.value;
    if (status?.state === 'reload') {
      if (reloaded) throw new Error('Module activation did not persist after reload.');
      await browserCall(debugPort, base, 'Page.reload');
      reloaded = true;
      return false;
    }
    if (status?.state === 'ready' && !status.active) {
      if (reloaded) throw new Error('Module is enabled but did not become active after reload.');
      await browserCall(debugPort, base, 'Page.reload');
      reloaded = true;
      return false;
    }
    return status?.state === 'ready' && status.active;
  }, 600000);
}

export async function main(config, args = process.argv.slice(3)) {
  if (args.includes('--help')) {
    console.log('Usage: start-dev [--watch]\nEnvironment: CHROMIUM_BIN, CHROMIUM_DEBUG_PORT, FOUNDRY_WORLD, FOUNDRY_PORT, FOUNDRY_DATA_PATH\nOptional setup credentials: FOUNDRY_ADMIN_USERNAME, FOUNDRY_ADMIN_PASSWORD');
    return;
  }
  if (args.some(arg => arg !== '--watch')) throw new Error('Unknown argument. Use --help.');
  if (Number(config.foundryVersion.split('.')[0]) !== 14) throw new Error('start-dev automatic setup requires Foundry 14. Use start-foundry for other versions.');
  const ROOT = await repositoryRoot(config.git);
  const env = process.env;
  const chromium = await executable(env.CHROMIUM_BIN ? [env.CHROMIUM_BIN] : ['chromium', 'chromium-browser']);
  const launcher = await executable([config.foundryLauncher]);
  const foundryPort = port(env.FOUNDRY_PORT, config.port);
  const debugPort = port(env.CHROMIUM_DEBUG_PORT, config.debugPort);
  if (foundryPort === debugPort) throw new Error('Foundry and Chromium need different ports.');
  const world = env.FOUNDRY_WORLD || config.worldId;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(world)) throw new Error('FOUNDRY_WORLD must be a lowercase slug.');
  const dataPath = resolve(ROOT, env.FOUNDRY_DATA_PATH || 'foundryvtt-data');
  const profile = resolve(ROOT, config.browserProfile);
  const base = `http://127.0.0.1:${foundryPort}`;
  const request = foundryClient(base);
  await freePort(foundryPort);
  await freePort(debugPort);
  const children = new Set();
  const groups = new Set();
  let stopping = false;
  let failure;
  const childEnv = { ...env, FOUNDRY_DATA_PATH: dataPath, FOUNDRY_PORT: String(foundryPort) };
  delete childEnv.FOUNDRY_ADMIN_PASSWORD;
  delete childEnv.FOUNDRY_ADMIN_USERNAME;
  function start(command, args, extraEnv = {}, required = true) {
    const child = spawn(command, args, { cwd: ROOT, env: { ...childEnv, ...extraEnv }, stdio: 'inherit', detached: true });
    children.add(child);
    child.on('spawn', () => groups.add(child.pid));
    child.on('error', error => { failure = error; children.delete(child); });
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (!required) groups.delete(child.pid);
      if (required && !stopping) failure = new Error(`${command} exited (${signal || code}).`);
    });
    return child;
  }
  function signalChildren(signal) {
    for (const pid of groups) {
      try { process.kill(-pid, signal); }
      catch (error) {
        if (error.code === 'ESRCH') groups.delete(pid);
        else console.error(error.message);
      }
    }
  }
  const stop = () => { stopping = true; signalChildren('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  async function waitFor(check, timeout = 120000, timeoutMessage = 'Timed out waiting for startup. See the logs above.') {
    const deadline = Date.now() + timeout;
    while (!stopping) {
      if (failure) throw failure;
      if (await check()) return;
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await delay(500);
    }
    throw new Error('Startup cancelled.');
  }
  try {
    let existing;
    const manifest = join(dataPath, 'Data', 'worlds', world, 'world.json');
    try { existing = JSON.parse(await readFile(manifest, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (existing.id !== world || existing.system !== config.worldSystem)) {
      throw new Error(`World ${world} does not match the configured development world.`);
    }
    // Build before Foundry opens any compendium databases.
    const build = start(await executable([config.buildCommand[0]]), config.buildCommand.slice(1), {}, false);
    const buildCode = await new Promise((accept, reject) => {
      build.once('exit', accept);
      build.once('error', reject);
    });
    if (buildCode !== 0 || stopping) throw new Error('Build failed or was cancelled.');
    await linkPackage(dataPath, resolve(ROOT, config.outputDirectory), config.packageType, config.packageId);
    await mkdir(profile, { recursive: true });
    // A missing requested world leaves Foundry in setup. Always override a
    // persisted default world: an empty --world value does not clear it in v14.
    start(launcher, [`--world=${world}`], {
      FOUNDRY_WORLD: world,
    });
    await waitFor(async () => {
      try { return (await request('/')).status < 400; }
      catch { return false; }
    });
    start(chromium, [
      `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profile}`, '--no-first-run', base,
    ]);
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) });
        return response.ok && Boolean((await response.json()).webSocketDebuggerUrl);
      } catch { return false; }
    });
    let prompted = '';
    let created = Boolean(existing);
    let launched = false;
    let needsManualSetup = false;
    let authenticated = false;
    await waitFor(async () => {
      const statusResponse = await request('/api/status');
      if (!statusResponse.ok) throw new Error('Foundry status endpoint failed.');
      const status = await statusResponse.json();
      if (status.active) {
        if (status.world !== world || status.system !== config.worldSystem) {
          throw new Error(`Unexpected active world: ${status.world} (${status.system}).`);
        }
        return true;
      }
      const home = await request('/');
      const location = home.headers.get('location');
      if (location === '/join' || location === '/game') return false;
      if (location === '/license') {
        if (prompted !== 'license') console.log('Accept the Foundry license in Chromium to continue.');
        prompted = 'license';
        return false;
      }
      if (launched || needsManualSetup) return false;
      if (env.FOUNDRY_ADMIN_PASSWORD && !authenticated) {
        authenticated = true;
        await request('/auth', { adminPassword: env.FOUNDRY_ADMIN_PASSWORD, adminUsername: env.FOUNDRY_ADMIN_USERNAME ?? null });
      }
      const response = await request(created ? '/setup' : '/create', created
        ? { action: 'launchWorld', world }
        : { action: 'createWorld', id: world, title: config.worldTitle, system: config.worldSystem, launch: false });
      if (response.status === 401 || response.status === 403) {
        if (prompted !== 'auth') console.log(`Administrator authentication required. Create/launch ${world} in Chromium, or restart with FOUNDRY_ADMIN_PASSWORD set.`);
        prompted = 'auth';
        needsManualSetup = true;
        return false;
      }
      if (!response.ok) throw new Error(`Foundry setup failed (HTTP ${response.status}).`);
      const result = await response.json();
      if (result.error) throw new Error(`Foundry setup: ${result.error}`);
      if (created) launched = true;
      created = true;
      return false;
    }, 600000);
    await browserCall(debugPort, base, 'Page.navigate', { url: `${base}/join` });
    if (config.packageType === 'module') await enableBrowserModule(debugPort, base, {
      worldId: world, worldSystem: config.worldSystem, packageId: config.packageId,
    }, (check, timeout) => waitFor(check, timeout, 'Timed out waiting for GM login and module activation.'));
    if (args.includes('--watch')) start(await executable([config.watchCommand[0]]), config.watchCommand.slice(1));
    console.log(`World ready: ${base}/join\nMCP browser endpoint: http://127.0.0.1:${debugPort}\nPress Ctrl+C to stop.`);
    while (!stopping) {
      if (failure) throw failure;
      await delay(500);
    }
  } finally {
    stop();
    const deadline = Date.now() + 5000;
    while (children.size && Date.now() < deadline) await delay(100);
    signalChildren('SIGKILL');
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  readFile(process.argv[2], 'utf8').then(JSON.parse).then(config => main(config))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
