'use strict';

const Homey = require('homey');
const { valueOf, isOnline } = require('./common');

const TYPE_MATCHERS = {
  omada_switch: ['switch'],
  omada_eap: ['eap', 'access point', 'ap'],
  omada_gateway: ['gateway', 'router'],
};

module.exports = class OmadaDriver extends Homey.Driver {
  async onPairListDevices() {
    const settings = this.homey.app.getOmadaSettings();
    const client = this.homey.app.getOmadaClient();
    if (this.id === 'omada_controller') {
      const status = await client.getControllerStatus();
      const info = await client.getControllerInfo();
      return [{
        name: String(status.name || info.controllerName || 'Omada Controller'),
        data: { id: `controller:${settings.omadacId}`, controllerId: settings.omadacId },
        settings: {
          model: String(status.model || 'Software Controller'),
          firmware: String(status.controllerVersion || info.controllerVer || 'Onbekend'),
          firmwareLatest: 'Laden…',
          uptime: String(valueOf(status, ['upTime', 'uptime']) || 'Onbekend'),
          mac: String(valueOf(status, ['macAddress', 'mac']) || 'Onbekend'),
          online: 'Online',
        },
      }];
    }
    let siteId = settings.siteId;
    if (!siteId) {
      const sites = await client.listSites();
      if (sites.length !== 1) throw new Error('Vul het Site ID in bij de Omada-appinstellingen.');
      siteId = valueOf(sites[0], ['siteId', 'id']);
    }
    if (this.id === 'omada_client') {
      const clients = await client.listKnownClients(siteId);
      return clients.map(item => {
        const mac = String(valueOf(item, ['mac', 'macAddress']) || '').toUpperCase().replaceAll(':', '-');
        const name = valueOf(item, ['name', 'hostName', 'hostname']) || mac;
        return {
          name: String(name),
          data: { id: `${siteId}:${mac}`, siteId, mac },
          settings: {
            mac,
            ip: String(valueOf(item, ['ip', 'ipAddress']) || 'Onbekend'),
            hostname: String(valueOf(item, ['hostName', 'hostname']) || 'Onbekend'),
            online: 'Status ophalen…',
          },
        };
      });
    }
    const devices = await client.listDevices(siteId);
    let portsByMac = new Map();
    if (this.id === 'omada_switch') {
      try {
        const rows = await client.listSwitchPortPoeInfo(siteId);
        portsByMac = rows.reduce((map, row) => {
          const key = String(row.switchMac || '').toLowerCase().replaceAll(':', '-');
          if (key) map.set(key, (map.get(key) || 0) + 1);
          return map;
        }, new Map());
      } catch (error) {
        this.homey.app.log(`Poortenaantal ophalen overgeslagen: ${error.message}`);
      }
    }
    const matchers = TYPE_MATCHERS[this.id] || [];
    return devices.filter(device => matchers.some(matcher => {
      const type = String(valueOf(device, ['deviceType', 'type', 'device_type', 'category']) || '').toLowerCase();
      return type.includes(matcher);
    })).map(device => {
      const mac = String(valueOf(device, ['mac', 'macAddress', 'deviceMac']) || '').toLowerCase();
      const id = String(valueOf(device, ['deviceId', 'id']) || mac);
      const name = valueOf(device, ['name', 'deviceName', 'alias']) || mac || id;
      return {
        name: String(name),
        data: { id: `${siteId}:${id}`, siteId, deviceId: id, mac },
        settings: {
          model: String(valueOf(device, ['model', 'deviceModel']) || 'Onbekend'),
          firmware: String(valueOf(device, ['firmwareVersion', 'version', 'firmware']) || 'Onbekend'),
          ip: String(valueOf(device, ['ip', 'ipAddress']) || 'Onbekend'),
          mac: mac || 'Onbekend',
          ...(this.id === 'omada_switch' ? { portCount: String(portsByMac.get(mac.replaceAll(':', '-')) || 'Onbekend') } : {}),
          uptime: String(valueOf(device, ['uptime', 'upTime']) || 'Onbekend'),
          cpu: String(valueOf(device, ['cpuUtil', 'cpuUsage', 'cpu_usage', 'cpu']) ?? 'Onbekend'),
          memory: String(valueOf(device, ['memUtil', 'memUsage', 'mem_usage', 'memoryUtil', 'memoryUsage', 'memory']) ?? 'Onbekend'),
          online: isOnline(device) ? 'Online' : 'Offline',
        },
      };
    });
  }
};
