'use strict';

const Homey = require('homey');

module.exports = class OmadaControllerDevice extends Homey.Device {
  async onInit() {
    await this.refreshController();
    this.pollTimer = this.homey.setInterval(() => {
      this.refreshController().catch(error => this.error(`Omada-controller bijwerken mislukt: ${error.message}`));
    }, 5 * 60 * 1000);
  }

  async refreshController() {
    const client = this.homey.app.getOmadaClient();
    const status = await client.getControllerStatus();
    const info = await client.getControllerUpdateInfo().catch(error => {
      this.log(`Controller-updategegevens ophalen overgeslagen: ${error.message}`);
      return {};
    });
    const update = info.hardware || info.software || {};
    const updates = {
      online: 'Online',
      model: String(status.model || 'Software Controller'),
      firmware: String(status.controllerVersion || 'Onbekend'),
      firmwareLatest: String(update.latestVersion || update.currentVersion || status.controllerVersion || 'Onbekend'),
      uptime: String(status.upTime || status.uptime || 'Onbekend'),
      mac: String(status.macAddress || 'Onbekend'),
      cpu: String(status.cpuUtil ?? status.cpuUsage ?? status.cpu ?? 'Onbekend'),
      memory: String(status.memUtil ?? status.memUsage ?? status.memoryUtil ?? status.memoryUsage ?? status.memory ?? 'Onbekend'),
    };
    await this.setSettings(updates);
    await this.setAvailable();
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }
};
