{ pkgs, ... }:

{
  zramSwap.enable = true;

  environment.systemPackages = with pkgs; [
    age
    curl
    git
    htop
    jq
    sops
    tmux
    vim
  ];
}
