'use strict';

const Homey = require('homey');
const { valueOf, isOnline } = require('./common');

const FIELDS = {
  model: ['model', 'deviceModel'],
  firmware: ['firmwareVersion', 'version', 'firmware'],
  ip: ['ip', 'ipAddress'],
  mac: ['mac', 'macAddress', 'deviceMac'],
  uptime: ['uptime', 'upTime'],
  cpu: ['cpuUtil', 'cpuUsage', 'cpu_usage', 'cpu'],
  memory: ['memUtil', 'memUsage', 'mem_usage', 'memoryUtil', 'memoryUsage', 'memory'],
};

module.exports = class OmadaDevice extends Homey.Device {
  async onInit() {
    await this.refreshInfo();
    this.pollTimer = this.homey.setInterval(() => {
      this.refreshInfo().catch(error => this.error('Omada-apparaat bijwerken mislukt: ' + error.message));
    }, 5 * 60 * 1000);
  }

  async refreshInfo() {
    try {
      const { siteId, deviceId, mac } = this.getData();
      const devices = await this.homey.app.getOmadaClient().listDevices(siteId);
      const device = devices.find(item => {
        const itemId = String(valueOf(item, ['deviceId', 'id']) || '');
        const itemMac = String(valueOf(item, ['mac', 'macAddress', 'deviceMac']) || '').toLowerCase();
        return (deviceId && itemId === String(deviceId)) || (mac && itemMac === String(mac).toLowerCase());
      });
      if (!device) throw new Error('Apparaat is niet gevonden in de controller.');
      const updates = {};
      for (const [setting, keys] of Object.entries(FIELDS)) {
        const value = valueOf(device, keys);
        if (value !== undefined) updates[setting] = String(value);
      }
      try {
        const firmware = await this.homey.app.getOmadaClient().getFirmwareInfo(siteId, mac);
        updates.firmwareLatest = String(valueOf(firmware, ['lastFwVer', 'latestVersion', 'latest_version'])
          || valueOf(firmware, ['curFwVer', 'currentVersion', 'current_version'])
          || updates.firmware || 'Onbekend');
      } catch (error) {
        this.log(`Nieuwste firmware ophalen overgeslagen: ${error.message}`);
      }
      updates.online = isOnline(device) ? 'Online' : 'Offline';
      if (this.driver.id === 'omada_switch') {
        try {
          const rows = await this.homey.app.getOmadaClient().listSwitchPortPoeInfo(siteId);
          const normalizedMac = String(mac || '').toLowerCase().replaceAll(':', '-');
          const switchPorts = rows.filter(row => String(row.switchMac || '').toLowerCase().replaceAll(':', '-') === normalizedMac);
          updates.portCount = String(switchPorts.length);
          const poePower = switchPorts.reduce((sum, row) => {
            const power = Number(valueOf(row, ['power', 'poePower', 'poe_power']));
            return sum + (Number.isFinite(power) ? power : 0);
          }, 0);
          await this.setCapabilityValue('measure_power', poePower);
        } catch (error) {
          this.log(`Poortenaantal ophalen overgeslagen: ${error.message}`);
        }
      }
      await this.setSettings(updates);
      if (updates.online === 'Online') await this.setAvailable();
      else await this.setUnavailable('Apparaat is offline volgens Omada.');
    } catch (error) {
      await this.setUnavailable(error.message);
      throw error;
    }
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }
};
