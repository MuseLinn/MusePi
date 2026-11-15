{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omp;
in
{
  options.programs.omp = {
    enable = lib.mkEnableOption "MusePi coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.omp.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "MusePi package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}
