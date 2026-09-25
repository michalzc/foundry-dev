{
  description = "Foundry VTT project development environment";

  inputs.foundry-dev.url = "github:michalzc/foundry-dev";

  outputs =
    { foundry-dev, ... }:
    let
      system = "x86_64-linux";
      env = foundry-dev.lib.mkFoundryEnvironment {
        inherit system;
        foundry = {
          version = "14.368";
          # Replace with the hash of your own licensed archive.
          sha256 = "sha256-SL5GxqPSTjE7k+1DNvwAcCgQfB70odihyREWFnMORsA=";
        };
        nodejsMajor = 24;
        port = 32000;
      };
    in
    {
      devShells.${system} = {
        default = env.devShell;
        foundry = env.devShell;
      };
      apps.${system}.start-foundry = env.app;
      packages.${system} = {
        foundryvtt = env.package;
        start-foundry = env.launcher;
      };
      formatter.${system} = env.formatter;
    };
}
