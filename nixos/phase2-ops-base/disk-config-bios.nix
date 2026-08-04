{ site, ... }:

{
  disko.devices = {
    disk.main = {
      device = site.disk;
      type = "disk";
      content = {
        type = "gpt";
        partitions = {
          BIOSBOOT = {
            size = "1M";
            type = "EF02";
          };
          root = {
            size = "100%";
            content = {
              type = "filesystem";
              format = "ext4";
              mountpoint = "/";
            };
          };
        };
      };
    };
  };
}
