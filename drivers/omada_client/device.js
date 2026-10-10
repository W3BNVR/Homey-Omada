'use strict';

const Homey = require('homey');

module.exports = class OmadaClientDevice extends Homey.Device {
  async onInit() {
    await this.refreshClient();
    this.pollTimer = this.homey.setInterval(() => {
      this.refreshClient().catch(error => this.error(`Omada-client bijwerken mislukt: ${error.message}`));
    }, 60 * 1000);
  }

  async refreshClient() {
    const { siteId, mac } = this.getData();
    const clients = await this.homey.app.getOmadaClient().listConnectedClients(siteId);
    const client = clients.find(item => String(item.mac || item.macAddress || '').toUpperCase().replaceAll(':', '-') === String(mac).toUpperCase());
    if (!client) {
      await this.setSettings({ online: 'Offline' });
      await this.setUnavailable('Client is niet verbonden met Omada.');
      return;
    }
    const ip = client.ip || client.ipAddress || 'Onbekend';
    const hostname = client.hostName || client.hostname || 'Onbekend';
    await this.setSettings({ ip: String(ip), hostname: String(hostname), online: 'Online' });
    await this.setAvailable();
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }
};
