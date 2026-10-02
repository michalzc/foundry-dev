{ nixpkgs }:
{
  system,
  foundry,
  nodejsMajor ? 24,
  port ? 32000,
  extraPackages ? [ ],
  shellHook ? "",
  development ? null,
}:
assert nixpkgs.lib.assertMsg (
  builtins.isInt port && port > 0 && port <= 65535
) "port must be an integer from 1 to 65535";
let
  pkgs = import nixpkgs {
    inherit system;
    config.allowUnfreePredicate =
      pkg:
      builtins.elem (nixpkgs.lib.getName pkg) [
        "foundryvtt"
        "FoundryVTT"
      ];
  };
  nodejs = pkgs.${"nodejs_${toString nodejsMajor}"};
  package = pkgs.callPackage ../nix/foundryvtt { inherit nodejs; } foundry;
  launcher = pkgs.writeShellApplication {
    name = "start-foundry";
    runtimeInputs = [
      pkgs.git
      pkgs.coreutils
      package
    ];
    text = ''
      dataPath="''${FOUNDRY_DATA_PATH:-}"
      if [[ -z "$dataPath" ]]; then
        if ! repositoryRoot=$(git rev-parse --show-toplevel 2>/dev/null); then
          echo "Run start-foundry inside the checkout or set FOUNDRY_DATA_PATH." >&2
          exit 1
        fi
        dataPath="$repositoryRoot/foundryvtt-data"
      fi

      port="''${FOUNDRY_PORT:-${toString port}}"
      if [[ ! "$port" =~ ^[0-9]{1,5}$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
        echo "FOUNDRY_PORT must be an integer from 1 to 65535." >&2
        exit 1
      fi
      mkdir -p -- "$dataPath"
      dataPath=$(realpath -- "$dataPath")
      args=("--port=$port" "--dataPath=$dataPath")
      if [[ -n "''${FOUNDRY_WORLD:-}" ]]; then
        args+=("--world=$FOUNDRY_WORLD")
      fi
      exec foundryvtt-${pkgs.lib.versions.major foundry.version} "''${args[@]}" "$@"
    '';
  };
  developmentConfig =
    {
      packageType,
      packageId,
      worldId,
      worldTitle,
      worldSystem ? if packageType == "system" then packageId else null,
      outputDirectory ? "build",
      buildCommand ? [
        "npm"
        "run"
        "build"
      ],
      watchCommand ? [
        "npm"
        "run"
        "dev"
      ],
      browserProfile ? ".dev/chromium",
      debugPort ? 9222,
    }:
    let
      slug = value: builtins.isString value && builtins.match "[a-z0-9]+(-[a-z0-9]+)*" value != null;
      command =
        value:
        builtins.isList value
        && value != [ ]
        && builtins.all builtins.isString value
        && builtins.head value != "";
      nonempty = value: builtins.isString value && value != "";
    in
    assert pkgs.lib.assertMsg (builtins.elem packageType [
      "system"
      "module"
    ]) "development.packageType must be system or module";
    assert pkgs.lib.assertMsg (slug packageId && slug worldId && slug worldSystem)
      "development packageId, worldId, and worldSystem must be lowercase slugs; modules require worldSystem";
    assert pkgs.lib.assertMsg (
      nonempty worldTitle && nonempty outputDirectory && nonempty browserProfile
    ) "development titles and paths must be nonempty strings";
    assert pkgs.lib.assertMsg (
      command buildCommand && command watchCommand
    ) "development commands must be nonempty lists of string arguments";
    assert pkgs.lib.assertMsg (
      builtins.isInt debugPort && debugPort >= 1024 && debugPort <= 65535 && debugPort != port
    ) "development.debugPort must be 1024–65535 and different from port";
    assert pkgs.lib.assertMsg (port >= 1024) "start-dev requires a Foundry port of at least 1024";
    {
      inherit
        packageType
        packageId
        worldId
        worldTitle
        worldSystem
        outputDirectory
        buildCommand
        watchCommand
        browserProfile
        debugPort
        port
        ;
      foundryVersion = foundry.version;
      foundryLauncher = "${launcher}/bin/start-foundry";
      git = "${pkgs.git}/bin/git";
    };
  config = developmentConfig development;
  configFile = pkgs.writeText "start-dev-config.json" (builtins.toJSON config);
  devLauncher = pkgs.writeShellApplication {
    passthru = { inherit config configFile; };
    name = "start-dev";
    runtimeInputs = [
      nodejs
      launcher
      pkgs.git
    ];
    text = ''
      exec ${nodejs}/bin/node ${../tools/start-dev.mjs} ${configFile} "$@"
    '';
  };
  devShell = pkgs.mkShell {
    packages = [
      nodejs
      package
      launcher
    ]
    ++ pkgs.lib.optional (development != null) devLauncher
    ++ extraPackages;
    shellHook = ''
      export FOUNDRY_APP_PATH="${package}/opt/foundryvtt-${package.version}"
      if [[ -f "$FOUNDRY_APP_PATH/resources/app/main.js" ]]; then
        export FOUNDRY_APP_PATH="$FOUNDRY_APP_PATH/resources/app"
      fi
      if repositoryRoot=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null); then
        apiLink="$repositoryRoot/foundryvtt-api"
        if [[ -e "$apiLink" && ! -L "$apiLink" ]]; then
          echo "Cannot create Foundry API symlink: $apiLink already exists and is not a symlink." >&2
        else
          ${pkgs.coreutils}/bin/ln -sfnT -- "$FOUNDRY_APP_PATH" "$apiLink"
        fi
        unset apiLink
      fi
      unset repositoryRoot
    ''
    + "\n"
    + shellHook;
  };
in
{
  inherit package launcher devShell;
  app = {
    type = "app";
    program = "${launcher}/bin/start-foundry";
    meta.description = "Start the project's Foundry VTT development server";
  };
  formatter = pkgs.nixfmt;
}
// pkgs.lib.optionalAttrs (development != null) {
  inherit devLauncher;
  devApp = {
    type = "app";
    program = "${devLauncher}/bin/start-dev";
    meta.description = "Build and launch the project's Foundry VTT development world and Chromium";
  };
}
