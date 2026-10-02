# foundry-dev

A reusable Nix flake for developing Foundry VTT systems and modules, extracted
from flexible-d6. Each project owns its exact Foundry version and archive hash;
this repository owns packaging, Node.js tooling, the launchers, and API links.

Repository: [michalzc/foundry-dev](https://github.com/michalzc/foundry-dev).

## Use in a project

Copy `templates/project/flake.nix`, `.envrc`, and the relevant `.gitignore`
entries into your project. Alternatively, from your project checkout:

```sh
nix flake init -t github:michalzc/foundry-dev
```

The template uses the public repository:

```nix
inputs.foundry-dev.url = "github:michalzc/foundry-dev";
```

For local development, change the input to `path:../foundry-dev` to use a
checkout beside your project.

Set `system`, `foundry.version`, `foundry.sha256`, and `nodejsMajor` in the
project flake. The supplied version/hash are the flexible-d6 example, not a
universal checksum. Download your licensed **Node.js archive** from Foundry,
rename it to `FoundryVTT-<version>.zip`, and compute its hash:

```sh
nix hash file --type sha256 FoundryVTT-14.368.zip
nix-store --add-fixed sha256 FoundryVTT-14.368.zip
```

Paste the first command's SRI hash into `foundry.sha256`. Every collaborator
needs an archive with the pinned hash and exact filename in their Nix store.
Archives, license keys, and application data are never included in this repo.

For Foundry 13, set the exact `13.<build>` version and its archive hash, and use
`nodejsMajor = 22;`. For Foundry 14 use Node.js 24. See Foundry's
[installation guide](https://foundryvtt.com/article/installation/) for runtime
requirements. The factory defaults to Node.js 24; it does not infer Node.js
from the Foundry version.

```sh
git add flake.nix .envrc .gitignore
nix flake lock
git add flake.lock
direnv allow
# Or, without direnv:
nix develop
```

Commit the project's lock file to pin its shared environment. Upgrade it with
`nix flake update foundry-dev`. This does not change the project's Foundry
version or hash. Each project can upgrade independently.

## Factory API

`foundry-dev.lib.mkFoundryEnvironment { ... }` accepts:

| Argument | Default | Purpose |
| --- | --- | --- |
| `system` | required | Nix platform, e.g. `x86_64-linux` |
| `foundry.version` | required | Exact Foundry version |
| `foundry.sha256` | required | Hash of the licensed ZIP |
| `nodejsMajor` | `24` | Select `nodejs_<major>` from pinned nixpkgs |
| `port` | `32000` | Default server port, 1–65535 |
| `extraPackages` | `[]` | Additional Nix derivations for the shell |
| `shellHook` | `""` | Shell commands appended after API link setup |
| `development` | `null` | Optional project configuration for `start-dev` (Foundry 13 or 14) |

It returns `devShell`, `app`, `package` (Foundry), `launcher`, and `formatter`.
With `development` configured it also returns `devLauncher` and `devApp`,
and adds `start-dev` to the shell. Map these to `packages.<system>.start-dev`
and `apps.<system>.start-dev`, as shown in the project template.
The template maps these to `devShells.<system>.default` / `.foundry`,
`apps.<system>.start-foundry`, `packages.<system>.foundryvtt` /
`.start-foundry`, and `formatter.<system>`.

For extra tooling, add a project nixpkgs input following the shared one:

```nix
inputs.nixpkgs.follows = "foundry-dev/nixpkgs";
# Include nixpkgs in the outputs arguments, then inside the factory call:
extraPackages = [ nixpkgs.legacyPackages.${system}.jq ];
shellHook = ''
  export MY_PROJECT_SETTING=development
'';
```

The shared flake intentionally has no default Foundry package or development
shell: consumers must choose their licensed archive. It exports a formatter,
template, factory, and license-free integration checks. Platform outputs cover
x86_64/aarch64 Linux and macOS; builds are validated on x86_64 Linux here.
The selected archive's native dependencies must support the target platform.

## Run and develop

```sh
start-foundry
# Or without entering the development shell:
nix run .#start-foundry
FOUNDRY_PORT=32001 FOUNDRY_WORLD=my-world start-foundry
FOUNDRY_DATA_PATH=/path/to/data start-foundry --noupdate
```

The launcher defaults to `foundryvtt-data` at the current Git checkout root,
including when run from a subdirectory. Outside Git, set `FOUNDRY_DATA_PATH`.
Relative data overrides resolve against the current working directory. Extra
arguments are forwarded to Foundry after the generated arguments. Use separate
data directories and ports for projects running concurrently.

Entering the shell exports `FOUNDRY_APP_PATH` and refreshes a `foundryvtt-api`
symlink at the Git root for editor navigation. Existing real files/directories
are preserved with a diagnostic. The API files remain read-only in the Nix
store. Custom hooks run after this setup.

## One-command development session

Keep npm dependencies and build scripts in the consuming project. Configure the
shared launcher in the factory call:

```nix
development = {
  packageType = "system";
  packageId = "my-system";
  worldId = "my-system-dev";
  worldTitle = "My System Development";
};
```

For a module, specify its development world's installed system:

```nix
development = {
  packageType = "module";
  packageId = "my-module";
  worldId = "my-module-dev";
  worldTitle = "My Module Development";
  worldSystem = "my-system";
};
```

| Development field | Default | Purpose |
| --- | --- | --- |
| `packageType` | required | `system` or `module` |
| `packageId` | required | Package ID used for output linking |
| `worldId` | required | Development world ID |
| `worldTitle` | required | Title used when creating the world |
| `worldSystem` | `packageId` for systems; required for modules | World system ID |
| `outputDirectory` | `"build"` | Output to link, relative to the Git root or absolute |
| `buildCommand` | `[ "npm" "run" "build" ]` | Executable and arguments, run before Foundry |
| `watchCommand` | `[ "npm" "run" "dev" ]` | Executable and arguments for `--watch` |
| `browserProfile` | `".dev/chromium"` | Persistent profile path, relative to the Git root or absolute |
| `debugPort` | `9222` | Chromium debugging port, 1024–65535 |

IDs must be lowercase slugs. Command arrays are passed directly to the process;
there is no shell expansion. Both development ports must be at least 1024 and
must differ. Paths containing spaces are supported. Add `/.dev/` and your
Foundry data directory to `.gitignore`.

Install Chromium on the host and npm dependencies once, then run:

```sh
start-dev
start-dev --watch
# Outside the shell:
nix run .#start-dev
nix run .#start-dev -- --watch
```

The generated command uses packaged Node.js and `start-foundry`. It discovers
`chromium` or `chromium-browser` on PATH; override with `CHROMIUM_BIN`. Run inside
the consuming project's Git checkout, including from a subdirectory. The
launcher resolves the checkout at runtime, builds, links the output into
`Data/systems/<packageId>` or `Data/modules/<packageId>`, starts Foundry, creates
or reuses the configured world, and opens Chromium's join screen. Existing
worlds must match the configured ID and system; unrelated package paths are
preserved and cause an error. Automatic setup supports Foundry 13 and 14; use
`start-foundry` for other versions.

| Environment override | Default |
| --- | --- |
| `FOUNDRY_PORT` | Factory `port` |
| `FOUNDRY_WORLD` | `development.worldId` |
| `FOUNDRY_DATA_PATH` | `foundryvtt-data` at the Git root |
| `CHROMIUM_BIN` | Host `chromium` or `chromium-browser` |
| `CHROMIUM_DEBUG_PORT` | `development.debugPort` |

Relative data paths for `start-dev` resolve against the Git root. This differs
from `start-foundry`, which resolves explicit relative overrides against the
working directory. CDP binds to loopback; update your browser tooling endpoint
if changing its port.

Enter the Foundry license and accept its terms in Chromium on first use. If
setup requires administrator authentication, set `FOUNDRY_ADMIN_PASSWORD` and
optionally `FOUNDRY_ADMIN_USERNAME`, or create/launch the world manually in
Chromium. The launcher uses credentials only for its HTTP session and excludes
them from child environments. Setup waits up to ten minutes. It assumes local
HTTP without TLS, route prefixes, reverse proxies, or external authentication.

For modules, install the configured world system and required modules first.
Join the world as GM in Chromium when prompted. The launcher waits up to ten
minutes, validates the project module and its recursive required module
dependencies, merges their activation into `core.moduleConfiguration`, reloads
when necessary, and verifies activation. It preserves other module settings,
does not download dependencies, and fails on missing or incompatible packages.
Player credentials are never configured; login remains interactive.

`--watch` starts the configured watcher after initialization. Reload the browser
after rebuilding. Ctrl+C or closing Chromium ends the session and stops owned
process groups, with a five-second graceful shutdown period. Occupied server or
debugging ports are refused. Do not run another Foundry instance using the same
output during a build, because build commands can replace compendium databases.

Without `development`, the factory and manual `start-foundry` workflow remain
unchanged. Link built system/module outputs yourself in that workflow.

## Work on this flake

```sh
nix fmt -- flake.nix lib/*.nix nix/foundryvtt/*.nix tests/*.nix templates/project/flake.nix
nix flake check
```

Checks package synthetic archives using both supported layouts (`main.js` and
`resources/app/main.js`) with Node.js 22 and 24. They exercise default data
paths from subdirectories, paths containing spaces, environment overrides,
argument forwarding, invalid ports, launches outside Git, and API link safety.
Development checks exercise generated system/module launchers, configuration
validation, and the Node.js launcher tests, including mocked HTTP and CDP
activation flows. They do not start a licensed Foundry server.
Run the runtime tests directly with `node --test tools/start-dev.test.mjs`. The lock file was copied from
flexible-d6 to preserve its toolchain baseline.
