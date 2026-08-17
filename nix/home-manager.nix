{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.omp;
  yaml = pkgs.formats.yaml { };
in
{
  options.programs.omp = {
    enable = lib.mkEnableOption "OMP coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.omp.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "OMP package to install.";
    };

    settings = lib.mkOption {
      type = lib.types.nullOr yaml.type;
      default = null;
      description = ''
        Settings written declaratively to {file}`~/.omp/agent/config.yml`.
        The file is a read-only store symlink: changes made from inside OMP
        (`/settings`, onboarding) replace it but revert on the next
        `home-manager switch`.
      '';
      example = {
        theme.dark = "titanium";
        startup.quiet = true;
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    home.file.".omp/agent/config.yml" = lib.mkIf (cfg.settings != null) {
      source = yaml.generate "omp-config.yml" cfg.settings;
    };
  };
}
