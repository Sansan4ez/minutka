{ lib, buildNpmPackage, makeWrapper, nodejs_22 }:

buildNpmPackage {
  pname = "minutka";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ../..;
    filter = path: type:
      let
        root = toString ../..;
        relative = lib.removePrefix (root + "/") (toString path);
      in
      toString path == root
      || relative == "package.json"
      || relative == "package-lock.json"
      || relative == "src"
      || lib.hasPrefix "src/" relative
      || relative == "migrations"
      || lib.hasPrefix "migrations/" relative
      # Agent-vault registry dependencies are validated at runtime. Keep the
      # referenced repository files in the immutable production package.
      || relative == "docs"
      || lib.hasPrefix "docs/" relative
      || relative == "specs"
      || lib.hasPrefix "specs/" relative
      || relative == "vault"
      || relative == "vault/assistant"
      || lib.hasPrefix "vault/assistant/" relative;
  };

  npmDepsHash = "sha256-tYnMyAgxKqJRK3fF4Fte54We6IC2AOLSApLH5roKH9c=";
  dontNpmBuild = true;
  npmFlags = [ "--legacy-peer-deps" ];
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    appDir="$out/lib/minutka"
    mkdir -p "$appDir"
    cp package.json package-lock.json "$appDir/"
    cp -r node_modules src migrations docs specs "$appDir/"
    mkdir -p "$appDir/vault"
    cp -r vault/assistant "$appDir/vault/"

    mkdir -p "$out/bin"
    makeWrapper ${lib.getExe nodejs_22} "$out/bin/minutka" \
      --add-flags "$appDir/node_modules/tsx/dist/cli.mjs" \
      --add-flags "$appDir/src/runtime/serve.ts"
    makeWrapper ${lib.getExe nodejs_22} "$out/bin/minutka-db-migrate" \
      --add-flags "$appDir/node_modules/tsx/dist/cli.mjs" \
      --add-flags "$appDir/src/infrastructure/postgres/migrate.ts"
    makeWrapper ${lib.getExe nodejs_22} "$out/bin/minutka-pilot-status" \
      --add-flags "$appDir/node_modules/tsx/dist/cli.mjs" \
      --add-flags "$appDir/src/runtime/pilot-status.ts"

    runHook postInstall
  '';

  meta = {
    description = "Telegram-first Minutka research assistant runtime";
    mainProgram = "minutka";
  };
}
