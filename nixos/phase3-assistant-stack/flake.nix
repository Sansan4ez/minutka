{
  description = "Phase 3: personal assistant production stack";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    # Keep this aligned with the installation phases while nixos-25.11 requires Disko 1.12.
    disko.url = "github:nix-community/disko/v1.12.0";
    disko.inputs.nixpkgs.follows = "nixpkgs";

    sops-nix.url = "github:Mic92/sops-nix";
    sops-nix.inputs.nixpkgs.follows = "nixpkgs";

    deploy-rs.url = "github:serokell/deploy-rs";
    deploy-rs.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, disko, sops-nix, deploy-rs, ... }:
    let
      site = import ./site.nix;
    in {
      nixosConfigurations.personal-assistant-1 = nixpkgs.lib.nixosSystem {
        system = site.system;
        specialArgs = { inherit site; };
        modules = [
          disko.nixosModules.disko
          sops-nix.nixosModules.sops
          ./disk-config.nix
          ./hosts/personal-assistant-1/default.nix
        ];
      };

      deploy = {
        sshOpts = [
          "-i"
          site.deploy.sshIdentityFile
          "-o"
          "IdentitiesOnly=yes"
        ];

        nodes.personal-assistant-1 = {
          hostname = site.deploy.sshHost;
          sshUser = site.deploy.sshUser;

          profiles.system = {
            user = "root";
            path = deploy-rs.lib.${site.system}.activate.nixos self.nixosConfigurations.personal-assistant-1;
          };
        };
      };

      checks = builtins.mapAttrs
        (_system: deployLib: deployLib.deployChecks self.deploy)
        deploy-rs.lib;
    };
}
