{
  description = "time-agent — Минутка AI dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f {
        inherit system;
        pkgs = import nixpkgs { inherit system; };
      });
    in
    {
      devShells = forAllSystems ({ pkgs, ... }: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
          shellHook = ''
            echo "time-agent dev shell — node $(node --version), npm $(npm --version)"
            if [ ! -d node_modules ]; then
              echo "node_modules missing — run: npm install"
            fi
          '';
        };
      });

      apps = forAllSystems ({ pkgs, system, ... }:
        let
          runner = name: script: {
            type = "app";
            program = toString (pkgs.writeShellApplication {
              name = "time-agent-${name}";
              runtimeInputs = [ pkgs.nodejs_22 ];
              text = ''
                if [ ! -d node_modules ]; then
                  echo "Installing dependencies…"
                  if [ -f package-lock.json ]; then npm ci; else npm install; fi
                fi
                exec npm run ${script}
              '';
            } + "/bin/time-agent-${name}");
          };
        in
        {
          dev     = runner "dev"     "mastra:dev";
          verify  = runner "verify"  "verify";
          test    = runner "test"    "test";
          specs   = runner "specs"   "specs";
          default = self.apps.${system}.dev;
        });

      formatter = forAllSystems ({ pkgs, ... }: pkgs.nixpkgs-fmt);
    };
}
