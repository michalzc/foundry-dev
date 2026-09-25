{
  lib,
  stdenvNoCC,
  requireFile,
  unzip,
  makeWrapper,
  nodejs,
  ...
}:
{
  version,
  sha256,
}:
let
  shortVersion = lib.versions.major version;
in
stdenvNoCC.mkDerivation {
  pname = "foundryvtt";
  inherit version;

  src = requireFile {
    name = "FoundryVTT-${version}.zip";
    inherit sha256;
    url = "https://foundryvtt.com";
    message = ''
      No foundry zip archive FoundryVTT-${version} found in the store.
      Download it and add to store: nix-store --add-fixed sha256 FoundryVTT-${version}.zip
    '';
  };

  nativeBuildInputs = [
    unzip
    makeWrapper
  ];
  dontUnpack = true;
  installPhase = ''
    runHook preInstall

    foundryDir="$out/opt/foundryvtt-${version}"
    mkdir -p "$foundryDir"
    unzip "$src" -d "$foundryDir"

    mkdir -p "$out/bin"
    if [ -f "$foundryDir/main.js" ]; then
      entryPoint="$foundryDir/main.js"
    elif [ -f "$foundryDir/resources/app/main.js" ]; then
      entryPoint="$foundryDir/resources/app/main.js"
    else
      echo "Foundry archive contains no supported entry point" >&2
      exit 1
    fi

    makeWrapper ${nodejs}/bin/node "$out/bin/foundryvtt-${shortVersion}" \
      --add-flags "$entryPoint"

    runHook postInstall
  '';

  meta.license = lib.licenses.unfree;
}
