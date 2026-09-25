{
  description = "Reusable Foundry VTT system and module development environments";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      lib.mkFoundryEnvironment = import ./lib/mk-foundry-environment.nix { inherit nixpkgs; };
      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
      checks = forAllSystems (
        system:
        import ./tests {
          inherit system;
          inherit (self.lib) mkFoundryEnvironment;
          pkgs = nixpkgs.legacyPackages.${system};
        }
      );
      templates.default = {
        path = ./templates/project;
        description = "Foundry VTT system or module development environment";
      };
    };
}
