'use strict';

const OmadaDriver = require('../../lib/omada-driver');
module.exports = class OmadaClientDriver extends OmadaDriver {
  async onInit() {
    this.clientCameOnline = this.homey.flow.getDeviceTriggerCard('client_came_online');
    this.clientWentOffline = this.homey.flow.getDeviceTriggerCard('client_went_offline');
  }

  async triggerClientPresence(device, online, client) {
    const card = online ? this.clientCameOnline : this.clientWentOffline;
    await card.trigger(device, {
      mac: client.mac,
      name: client.name,
      ip: client.ip || '',
    }, {});
  }
};
