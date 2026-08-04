{ site, ... }:

{
  networking = {
    useDHCP = false;

    interfaces.${site.network.interface} = {
      useDHCP = false;
      ipv4.addresses = [
        {
          address = site.network.address;
          prefixLength = site.network.prefixLength;
        }
      ];
      ipv4.routes = [
        {
          address = site.network.gateway;
          prefixLength = 32;
        }
      ];
    };

    defaultGateway = {
      address = site.network.gateway;
      interface = site.network.interface;
    };

    nameservers = site.network.nameservers;
  };
}
