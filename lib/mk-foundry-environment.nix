{ nixpkgs }:
{
  system,
  foundry,
  nodejsMajor ? 24,
  port ? 32000,
  extraPackages ? [ ],
  shellHook ? "",
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
  devShell = pkgs.mkShell {
    packages = [
      nodejs
      package
      launcher
    ]
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
