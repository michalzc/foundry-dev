# foundry-dev

A reusable Nix flake for developing Foundry VTT systems and modules, extracted
from flexible-d6. Each project owns its exact Foundry version and archive hash;
this repository owns packaging, Node.js tooling, the launcher, and API links.

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

It returns `devShell`, `app`, `package` (Foundry), `launcher`, and `formatter`.
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

Keep npm dependencies, build scripts, and output linking in the consuming
project. After building, link a system or module as appropriate (replace the
example ID and `build` directory):

```sh
mkdir -p foundryvtt-data/Data/systems
ln -s "$PWD/build" foundryvtt-data/Data/systems/my-system
# For a module:
mkdir -p foundryvtt-data/Data/modules
ln -s "$PWD/build" foundryvtt-data/Data/modules/my-module
```

Use your configured data directory if overriding `FOUNDRY_DATA_PATH`.
For flexible-d6, the output directory is `build` and system ID is `flexible-d6`.
Replacing its flake with the template preserves the existing shell alias,
launcher, local data directory, API link, and npm workflow.

## Work on this flake

```sh
nix fmt -- flake.nix lib/*.nix nix/foundryvtt/*.nix tests/*.nix templates/project/flake.nix
nix flake check
```

Checks package synthetic archives using both supported layouts (`main.js` and
`resources/app/main.js`) with Node.js 22 and 24. They exercise default data
paths from subdirectories, paths containing spaces, environment overrides,
argument forwarding, invalid ports, launches outside Git, and API link safety.
They do not start a licensed Foundry server. The lock file was copied from
flexible-d6 to preserve its toolchain baseline.
