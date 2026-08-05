{ lib, buildNpmPackage, makeWrapper, nodejs_22 }:

buildNpmPackage {
  pname = "personal-assistant";
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
      || relative == "vault"
      || relative == "vault/assistant"
      || lib.hasPrefix "vault/assistant/" relative;
  };

  npmDepsHash = "sha256-rfnTVVyiKfcsbd+Neo5oMbeIzge0ex8qJfnXLgmiKIY=";
  dontNpmBuild = true;
  npmFlags = [ "--legacy-peer-deps" ];
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    appDir="$out/lib/personal-assistant"
    mkdir -p "$appDir"
    cp package.json package-lock.json "$appDir/"
    cp -r node_modules src migrations "$appDir/"
    mkdir -p "$appDir/vault"
    cp -r vault/assistant "$appDir/vault/"

    mkdir -p "$out/bin"
    makeWrapper ${lib.getExe nodejs_22} "$out/bin/personal-assistant" \
      --add-flags "$appDir/node_modules/tsx/dist/cli.mjs" \
      --add-flags "$appDir/src/runtime/serve.ts"

    runHook postInstall
  '';

  meta = {
    description = "Telegram-first personal AI assistant runtime";
    mainProgram = "personal-assistant";
  };
}
