'use strict';

function first(device, keys) {
  for (const key of keys) {
    const value = device?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeMac(value) {
  return String(value || '').toLowerCase().replaceAll(':', '-');
}

module.exports = {
  async getDevice({ homey, params }) {
    const drivers = ['omada_switch', 'omada_gateway', 'omada_eap'];
    let selected = null;
    let selectedDriver = '';
    for (const driverId of drivers) {
      const driver = homey.drivers.getDriver(driverId);
      const registered = driver.getDevices();
      const devices = Array.isArray(registered) ? registered : Object.values(registered || {});
      selected = devices.find(device => String(device.getId()) === String(params.deviceId));
      if (selected) {
        selectedDriver = driverId;
        break;
      }
    }
    if (!selected) throw new Error('Selecteer in de widgetinstellingen een gekoppelde Omada-switch, gateway of EAP.');

    const { siteId, deviceId, mac } = selected.getData();
    if (!siteId || !mac) throw new Error('Het geselecteerde Omada-apparaat mist een Site ID of MAC-adres.');
    const client = homey.app.getOmadaClient();
    const normalizedMac = normalizeMac(mac);
    const listedDevices = await client.listDevices(siteId);
    const source = listedDevices.find(device =>
      normalizeMac(first(device, ['mac', 'macAddress', 'deviceMac'])) === normalizedMac
      || String(first(device, ['deviceId', 'id']) || '') === String(deviceId || ''));
    if (!source) throw new Error('Dit apparaat is niet gevonden in de Omada-controller.');

    const type = selectedDriver === 'omada_switch' ? 'switch'
      : selectedDriver === 'omada_gateway' ? 'gateway' : 'eap';
    let ports = [];
    if (type === 'switch') {
      const rows = await client.listSwitchPortPoeInfo(siteId);
      ports = rows.filter(row => normalizeMac(row.switchMac) === normalizedMac).map(row => ({
        ...row.portStatus,
        port: first(row, ['port']) ?? first(row.portStatus, ['port']),
        portName: first(row, ['portName']),
        connectedStatus: first(row, ['connectedStatus']),
        disabled: first(row, ['disable']),
        poeSupported: row.supportPoe === true
          || (row.poeDisplayType !== undefined && row.poeDisplayType !== null && Number(row.poeDisplayType) >= 0),
        poeMode: first(row, ['poe']),
        poeStatus: first(row.portStatus, ['poe']),
        power: first(row.portStatus, ['poePower']) ?? first(row, ['power']),
      }));
    } else if (type === 'gateway') {
      const gateway = await client.getGateway(siteId, mac);
      const statuses = gateway.portStatus || gateway.portStats || [];
      const configs = gateway.portConfigs || gateway.portConfig || [];
      ports = (configs.length ? configs : statuses).map(config => {
        const number = first(config, ['port', 'portNumber', 'portId']);
        const status = statuses.find(row => String(first(row, ['port', 'portNumber', 'portId'])) === String(number)) || config.portStat || {};
        const poeMode = first(config, ['poeMode', 'poe']);
        const mode = first(status, ['mode']) ?? first(config, ['mode']);
        return {
          ...config, ...status, port: number,
          portName: first(config, ['portDesc', 'name', 'portName']) || `Poort ${number}`,
          linkStatus: first(status, ['status', 'linkStatus']),
          linkSpeed: first(status, ['speed', 'linkSpeed']), poeMode,
          poeStatus: first(status, ['poe']),
          poeSupported: poeMode !== undefined && poeMode !== null && Number(poeMode) !== -1,
          isWan: Number(mode) === 0 || String(mode).toLowerCase() === 'wan',
          wanConnected: Number(first(status, ['internetState'])) > 0,
          ipv6Connected: Number(status.wanPortIpv6Config?.internetState) > 0,
          ip: first(status, ['ip']),
        };
      });
    } else {
      const accessPoint = await client.getAccessPoint(siteId, mac);
      ports = (accessPoint.lanPortSettings || []).map(port => ({
        ...port, port: port.lanPort || port.id, portName: port.lanPort || port.id,
        poeSupported: port.supportPoe === true, poeMode: port.poeOutEnable ? 1 : 0,
      }));
    }

    const settings = selected.getSettings();
    return {
      device: {
        id: selected.getId(), siteId, name: selected.getName(), type,
        model: first(source, ['model', 'deviceModel']) || settings.model || '—',
        firmware: first(source, ['firmwareVersion', 'version', 'firmware']) || settings.firmware || '—',
        ip: first(source, ['ip', 'ipAddress']) || settings.ip || '—',
        mac, status: first(source, ['statusCategory', 'status_category', 'status', 'deviceStatus', 'onlineStatus']),
        ports,
      },
    };
  },

  async getDevices({ homey }) {
    const settings = homey.app.getOmadaSettings();
    const client = homey.app.getOmadaClient();
    let siteId = settings.siteId;
    if (!siteId) {
      const sites = await client.listSites();
      if (sites.length !== 1) return { needsSiteId: true, devices: [] };
      siteId = first(sites[0], ['siteId', 'id']);
    }

    const devices = await client.listDevices(siteId);
    const [switchPortRows, gatewayRows, eapRows] = await Promise.all([
      client.listSwitchPortPoeInfo(siteId).catch(error => {
        homey.app.log(`Switchpoorten ophalen voor widget mislukt: ${error.message}`);
        return [];
      }),
      Promise.all(devices
        .filter(device => String(first(device, ['deviceType', 'type', 'device_type', 'category']) || '').toLowerCase().includes('gateway'))
        .map(async device => {
          const mac = first(device, ['mac', 'macAddress', 'deviceMac']);
          if (!mac) return null;
          try {
            return { mac, gateway: await client.getGateway(siteId, mac) };
          } catch (error) {
            homey.app.log(`Gatewaypoorten ophalen voor widget mislukt: ${error.message}`);
            return null;
          }
        })),
      Promise.all(devices
        .filter(device => String(first(device, ['deviceType', 'type', 'device_type', 'category']) || '').toLowerCase().match(/eap|access point|\bap\b/))
        .map(async device => {
          const mac = first(device, ['mac', 'macAddress', 'deviceMac']);
          if (!mac) return null;
          try {
            return { mac, accessPoint: await client.getAccessPoint(siteId, mac) };
          } catch (error) {
            homey.app.log(`EAP-poorten ophalen voor widget mislukt: ${error.message}`);
            return null;
          }
        })),
    ]);
    const portsByMac = new Map();
    for (const row of switchPortRows) {
      const mac = normalizeMac(first(row, ['switchMac']));
      if (!mac) continue;
      const ports = portsByMac.get(mac) || [];
      ports.push({
        ...row.portStatus,
        port: first(row, ['port']) ?? first(row.portStatus, ['port']),
        portName: first(row, ['portName']),
        connectedStatus: first(row, ['connectedStatus']),
        disabled: first(row, ['disable']),
        poeSupported: row.supportPoe === true
          || (row.poeDisplayType !== undefined && row.poeDisplayType !== null && Number(row.poeDisplayType) >= 0),
        poeMode: first(row, ['poe']),
        poeStatus: first(row.portStatus, ['poe']),
        power: first(row.portStatus, ['poePower']) ?? first(row, ['power']),
      });
      portsByMac.set(mac, ports);
    }
    for (const item of gatewayRows.filter(Boolean)) {
      const mac = normalizeMac(item.mac);
      const gateway = item.gateway;
      const statuses = gateway.portStatus || gateway.portStats || [];
      const configs = gateway.portConfigs || gateway.portConfig || [];
      const source = configs.length ? configs : statuses;
      portsByMac.set(mac, source.map(config => {
        const number = first(config, ['port', 'portNumber', 'portId']);
        const status = statuses.find(row => String(first(row, ['port', 'portNumber', 'portId'])) === String(number)) || config.portStat || {};
        const poeMode = first(config, ['poeMode', 'poe']);
        const mode = first(status, ['mode']) ?? first(config, ['mode']);
        return {
          ...config,
          ...status,
          port: number,
          portName: first(config, ['portDesc', 'name', 'portName']) || `Poort ${number}`,
          linkStatus: first(status, ['status', 'linkStatus']),
          linkSpeed: first(status, ['speed', 'linkSpeed']),
          poeMode,
          poeStatus: first(status, ['poe']),
          poeSupported: poeMode !== undefined && poeMode !== null && Number(poeMode) !== -1,
          isWan: Number(mode) === 0 || String(mode).toLowerCase() === 'wan',
          wanConnected: Number(first(status, ['internetState'])) > 0,
          ipv6Connected: Number(status.wanPortIpv6Config?.internetState) > 0,
          ip: first(status, ['ip']),
        };
      }));
    }
    for (const item of eapRows.filter(Boolean)) {
      const mac = normalizeMac(item.mac);
      const configs = item.accessPoint.lanPortSettings || [];
      portsByMac.set(mac, configs.map(port => ({
        ...port,
        port: port.lanPort || port.id,
        portName: port.lanPort || port.id,
        poeSupported: port.supportPoe === true,
        poeMode: port.poeOutEnable ? 1 : 0,
      })));
    }
    return {
      devices: devices.map(device => ({
        id: String(first(device, ['deviceId', 'id', 'mac', 'macAddress']) || ''),
        siteId,
        name: String(first(device, ['name', 'deviceName', 'alias', 'mac', 'macAddress']) || 'Omada-apparaat'),
        type: String(first(device, ['deviceType', 'type', 'device_type', 'category']) || ''),
        model: String(first(device, ['model', 'deviceModel']) || '—'),
        firmware: String(first(device, ['firmwareVersion', 'version', 'firmware']) || '—'),
        ip: String(first(device, ['ip', 'ipAddress']) || '—'),
        mac: String(first(device, ['mac', 'macAddress', 'deviceMac']) || '—'),
        status: first(device, ['statusCategory', 'status_category', 'status', 'deviceStatus', 'onlineStatus']),
        ports: portsByMac.get(normalizeMac(first(device, ['mac', 'macAddress', 'deviceMac']))) || [],
        clients: first(device, ['clientCount', 'connectedClientNum', 'connectedClients'])
      }))
    };
  },

  async setPoeMode({ homey, params, body }) {
    if (typeof body?.enabled !== 'boolean') throw new Error('Kies of PoE aan of uit moet.');
    const deviceType = String(params.deviceType || 'switch').toLowerCase();
    if (deviceType === 'eap') {
      const result = await homey.app.getOmadaClient().setAccessPointPortPoe(
        params.siteId, params.switchMac, params.port, body.enabled,
      );
      return { enabled: body.enabled, result };
    }
    if (deviceType === 'gateway') {
      const result = await homey.app.getOmadaClient().setGatewayPoe(
        params.siteId, params.switchMac, params.port, body.enabled,
      );
      return { enabled: body.enabled, result };
    }
    const result = await homey.app.getOmadaClient().updateSwitchPortPoe(
      params.siteId,
      params.switchMac,
      params.port,
      body.enabled,
    );
    return { enabled: body.enabled, result };
  },

  async setPortEnabled({ homey, params, body }) {
    if (typeof body?.enabled !== 'boolean') throw new Error('Kies of de poort aan of uit moet.');
    const result = await homey.app.getOmadaClient().setSwitchPortEnabled(
      params.siteId, params.switchMac, params.port, body.enabled,
    );
    return { enabled: body.enabled, result };
  },

  async setGatewayWanConnected({ homey, params, body }) {
    if (typeof body?.connected !== 'boolean') throw new Error('Kies of de WAN-poort moet verbinden of verbreken.');
    const result = await homey.app.getOmadaClient().setGatewayWanConnected(
      params.siteId, params.switchMac, params.port, body.connected, body.ipv6 === true,
    );
    return { connected: body.connected, result };
  },

  async setMultiPoeMode({ homey, params, body }) {
    if (typeof body?.enabled !== 'boolean' || !Array.isArray(body?.ports)) {
      throw new Error('Kies PoE aan of uit en geef een lijst met poorten op.');
    }
    const result = await homey.app.getOmadaClient().setSwitchPortsPoeMode(
      params.siteId,
      params.switchMac,
      body.ports,
      body.enabled,
    );
    return { enabled: body.enabled, result };
  },

  async recoverPoe({ homey, params, body }) {
    if (!Array.isArray(body?.ports)) throw new Error('Geef een lijst met poorten op voor PoE-herstel.');
    const result = await homey.app.getOmadaClient().recoverSwitchPortsPoe(
      params.siteId,
      params.switchMac,
      body.ports,
    );
    return { result };
  }
};
