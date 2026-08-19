{
  description = "Phase 1: installable base for Minutka VPS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    # Disko >= 1.13 is incompatible with nixos-25.11 VM tests
    # (https://github.com/nix-community/disko/issues/1203).
    disko.url = "github:nix-community/disko/v1.12.0";
    disko.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, disko, ... }:
    let
      site = import ./site.nix;
    in {
      nixosConfigurations.minutka-1 = nixpkgs.lib.nixosSystem {
        system = site.system;
        specialArgs = { inherit site; };
        modules = [
          disko.nixosModules.disko
          ./disk-config.nix
          ./hosts/minutka-1/default.nix
        ];
      };
    };
}
