{
  description = "Phase 1: installable base for personal assistant VPS";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    disko.url = "github:nix-community/disko";
    disko.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, disko, ... }:
    let
      site = import ./site.nix;
    in {
      nixosConfigurations.personal-assistant-1 = nixpkgs.lib.nixosSystem {
        system = site.system;
        specialArgs = { inherit site; };
        modules = [
          disko.nixosModules.disko
          ./disk-config.nix
          ./hosts/personal-assistant-1/default.nix
        ];
      };
    };
}
