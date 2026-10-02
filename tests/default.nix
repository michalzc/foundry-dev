{
  pkgs,
  system,
  mkFoundryEnvironment,
}:
let
  replaceDependency =
    original: replacement: text:
    builtins.replaceStrings [ (builtins.unsafeDiscardStringContext "${original}") ] [ "${replacement}" ]
      (
        builtins.appendContext (builtins.unsafeDiscardStringContext text) (
          builtins.removeAttrs (builtins.getContext text) [
            (builtins.unsafeDiscardStringContext original.drvPath)
            (builtins.unsafeDiscardStringContext original.outPath)
          ]
        )
      );
  developmentCheck =
    packageType:
    let
      env = mkFoundryEnvironment {
        inherit system;
        foundry = {
          version = "14.999";
          sha256 = pkgs.lib.fakeHash;
        };
        development = {
          inherit packageType;
          packageId = "example-package";
          worldId = "example-world";
          worldTitle = "Example Development";
          worldSystem = "example-system";
          outputDirectory = "output with spaces";
          buildCommand = [
            "false"
            "argument with spaces"
          ];
        };
      };
      fakeFoundry = pkgs.writeShellScriptBin "start-foundry" "exit 99";
      configFile = pkgs.writeText "fixture-config.json" (
        builtins.toJSON (
          env.devLauncher.config
          // {
            foundryLauncher = "${fakeFoundry}/bin/start-foundry";
          }
        )
      );
      generated = env.devLauncher.overrideAttrs (old: {
        text = replaceDependency env.launcher fakeFoundry (
          replaceDependency env.devLauncher.configFile configFile old.text
        );
      });
    in
    pkgs.runCommand "start-dev-${packageType}-integration"
      {
        nativeBuildInputs = [
          generated
          pkgs.git
          pkgs.nodejs_24
        ];
      }
      ''
        mkdir -p "project with spaces/subdir"
        start-dev --help | grep 'Usage: start-dev'
        cd "project with spaces"
        git init -q
        cd subdir
        # Build failure proves root/configuration resolution without starting Foundry.
        if CHROMIUM_BIN=true start-dev > log 2>&1; then exit 1; fi
        grep 'Build failed' log
        if CHROMIUM_BIN=true start-dev --unknown > log 2>&1; then exit 1; fi
        grep 'Unknown argument' log
        cd "$TMPDIR"
        if CHROMIUM_BIN=true start-dev > log 2>&1; then exit 1; fi
        grep 'inside the project Git checkout' log
        touch "$out"
      '';
  validConfig = {
    packageType = "module";
    packageId = "example";
    worldId = "example-dev";
    worldTitle = "Example";
    worldSystem = "example-system";
  };
  accepts =
    development:
    (builtins.tryEval (
      builtins.deepSeq
        (mkFoundryEnvironment {
          inherit system development;
          foundry = {
            version = "14.999";
            sha256 = pkgs.lib.fakeHash;
          };
        }).devLauncher.config
        true
    )).success;
  check =
    version: layout:
    let
      env = mkFoundryEnvironment {
        inherit system;
        foundry = {
          inherit version;
          sha256 = pkgs.lib.fakeHash;
        };
        nodejsMajor = if pkgs.lib.versions.major version == "13" then 22 else 24;
        shellHook = "export CUSTOM_HOOK=loaded";
      };
      archive = pkgs.runCommand "fixture-${version}.zip" { nativeBuildInputs = [ pkgs.zip ]; } ''
        mkdir -p fixture/${layout}
        echo 'console.log(JSON.stringify(process.argv.slice(2)))' > fixture/${layout}/main.js
        cd fixture
        zip -qr "$out" .
      '';
      fixture = env.package.overrideAttrs { src = archive; };
      # Replace both the store path and its Nix dependency context, so checks
      # never try to build the licensed requireFile archive.
      replace =
        text:
        builtins.replaceStrings [ (builtins.unsafeDiscardStringContext "${env.package}") ] [ "${fixture}" ]
          (
            builtins.appendContext (builtins.unsafeDiscardStringContext text) (
              builtins.removeAttrs (builtins.getContext text) [
                (builtins.unsafeDiscardStringContext env.package.drvPath)
                (builtins.unsafeDiscardStringContext env.package.outPath)
              ]
            )
          );
      launcher = env.launcher.overrideAttrs (old: {
        text = replace old.text;
      });
      hook = pkgs.writeText "shell-hook" (replace env.devShell.shellHook);
    in
    pkgs.runCommand "foundry-${version}-integration"
      {
        nativeBuildInputs = [
          pkgs.git
          pkgs.nodejs_24
          launcher
        ];
      }
      ''
        export HOME="$TMPDIR/home"
        mkdir -p "$HOME" "project with spaces/subdir"
        cd "project with spaces"
        git init -q
        root="$PWD"
        cd subdir
        source ${hook}
        test "$CUSTOM_HOOK" = loaded
        test "$(readlink "$root/foundryvtt-api")" = "$FOUNDRY_APP_PATH"
        test -f "$FOUNDRY_APP_PATH/main.js"
        start-foundry > args.json
        node -e 'const a=require("./args.json"); if (JSON.stringify(a)!==JSON.stringify(["--port=32000","--dataPath="+process.argv[1]+"/foundryvtt-data"])) process.exit(1)' "$root"
        test -d "$root/foundryvtt-data"
        export FOUNDRY_PORT=32123 FOUNDRY_WORLD="test world" FOUNDRY_DATA_PATH="custom data"
        start-foundry --noupdate > args.json
        node -e 'const a=require("./args.json"); if (JSON.stringify(a)!==JSON.stringify(["--port=32123","--dataPath="+process.cwd()+"/custom data","--world=test world","--noupdate"])) process.exit(1)'
        if FOUNDRY_PORT=65536 start-foundry; then exit 1; fi
        rm "$root/foundryvtt-api"
        mkdir "$root/foundryvtt-api"
        source ${hook}
        test -d "$root/foundryvtt-api"
        test ! -L "$root/foundryvtt-api"
        cd "$TMPDIR"
        unset FOUNDRY_DATA_PATH
        if start-foundry; then exit 1; fi
        FOUNDRY_DATA_PATH="$TMPDIR/standalone" start-foundry > /dev/null
        touch "$out"
      '';
in
{
  development-system = developmentCheck "system";
  development-module = developmentCheck "module";
  development-config =
    assert accepts validConfig;
    assert !(accepts (builtins.removeAttrs validConfig [ "worldSystem" ]));
    assert !(accepts (validConfig // { packageType = "other"; }));
    assert !(accepts (validConfig // { packageId = "../escape"; }));
    assert !(accepts (validConfig // { buildCommand = [ ]; }));
    assert !(accepts (validConfig // { debugPort = 32000; }));
    pkgs.runCommand "start-dev-config-validation" { } "touch $out";
  development-runtime =
    pkgs.runCommand "start-dev-runtime-tests"
      {
        nativeBuildInputs = [ pkgs.nodejs_24 ];
      }
      ''
        node --test ${../tools}/start-dev.test.mjs
        touch "$out"
      '';
  foundry-13 = check "13.999" ".";
  foundry-14 = check "14.999" "resources/app";
}
