'use strict';

const Homey = require('homey');
const { OmadaClient } = require('./lib/omada-client');
const { normalizeMac, clientMac } = require('./lib/common');

module.exports = class OmadaControllerApp extends Homey.App {
  async onInit() {
    this.log('Homey.OmadaIntegration initialized');
    this.registerFlowCards();
    const settings = this.getOmadaSettings();
    this.clientSnapshot = null;
    this.clientPollInProgress = false;
    this.clientPollTimer = this.homey.setInterval(() => {
      this.pollClientPresence().catch(error => this.error(`Omada-clients controleren mislukt: ${error.message}`));
    }, 60 * 1000);
    if (settings.controllerUrl && settings.omadacId && settings.clientId && settings.clientSecret) {
      try {
        const sites = await this.testConnection();
        this.log(`Connected to Omada; ${sites.length} site(s) available`);
      } catch (error) {
        this.error(`Omada connection failed: ${error.message}`);
        return;
      }
      await this.pollClientPresence().catch(error => this.error(`Omada-clients controleren mislukt: ${error.message}`));
    }
  }

  getOmadaSettings() {
    const names = ['controllerUrl', 'omadacId', 'clientId', 'clientSecret', 'siteId', 'allowSelfSigned', 'controllerUsername', 'controllerPassword'];
    return Object.fromEntries(names.map(name => [name, this.homey.settings.get(name)]));
  }

  getOmadaClient() {
    const settings = this.getOmadaSettings();
    if (!this.omadaClient || this.omadaClientKey !== JSON.stringify(settings)) {
      this.omadaClient = new OmadaClient(settings, message => this.log(message));
      this.omadaClientKey = JSON.stringify(settings);
    }
    return this.omadaClient;
  }

  async testConnection() {
    const sites = await this.getOmadaClient().listSites();
    return sites.map(site => ({
      id: site.siteId || site.id,
      name: site.name || site.siteName || site.siteId,
    }));
  }

  registerFlowCards() {
    const flow = this.homey.flow;
    flow.getActionCard('switch_poe_on').registerRunListener(async ({ device, port }) =>
      this.runPoeFlowAction(device, port, 'aan'));
    flow.getActionCard('switch_poe_off').registerRunListener(async ({ device, port }) =>
      this.runPoeFlowAction(device, port, 'uit'));
    flow.getActionCard('switch_poe_recover').registerRunListener(async ({ device, port }) =>
      this.runPoeFlowAction(device, port, 'herstellen'));
    flow.getActionCard('client_reconnect').registerRunListener(async ({ mac }) =>
      this.runClientFlowAction('reconnectClient', mac));
    flow.getActionCard('client_block').registerRunListener(async ({ mac }) =>
      this.runClientFlowAction('blockClient', mac));
    flow.getActionCard('client_unblock').registerRunListener(async ({ mac }) =>
      this.runClientFlowAction('unblockClient', mac));
    flow.getActionCard('client_set_name').registerRunListener(async ({ mac, name }) => {
      const siteId = await this.resolveSiteId();
      await this.getOmadaClient().setClientName(siteId, mac, name);
      return true;
    });
    flow.getActionCard('device_firmware_upgrade').registerRunListener(async ({ mac }) => {
      const siteId = await this.resolveSiteId();
      await this.getOmadaClient().startFirmwareUpgrade(siteId, mac);
      return true;
    });
    flow.getActionCard('gateway_poe_on').registerRunListener(async ({ mac, port }) =>
      this.runGatewayPoeAction(mac, port, true));
    flow.getActionCard('gateway_poe_off').registerRunListener(async ({ mac, port }) =>
      this.runGatewayPoeAction(mac, port, false));
    flow.getActionCard('gateway_wan_connect').registerRunListener(async ({ mac, port, ipv6 }) =>
      this.runGatewayWanAction(mac, port, true, ipv6));
    flow.getActionCard('gateway_wan_disconnect').registerRunListener(async ({ mac, port, ipv6 }) =>
      this.runGatewayWanAction(mac, port, false, ipv6));
    flow.getActionCard('switch_port_enable').registerRunListener(async ({ mac, port }) =>
      this.runSwitchPortStateAction(mac, port, true));
    flow.getActionCard('switch_port_disable').registerRunListener(async ({ mac, port }) =>
      this.runSwitchPortStateAction(mac, port, false));
    flow.getConditionCard('gateway_wan_connected').registerRunListener(async ({ mac, port, ipv6 }) => {
      const status = await this.getGatewayPortStatus(mac, port);
      return Number(ipv6 ? status.wanPortIpv6Config?.internetState : status.internetState) > 0;
    });
    flow.getConditionCard('gateway_port_connected').registerRunListener(async ({ mac, port }) => {
      const status = await this.getGatewayPortStatus(mac, port);
      return Number(status.status) === 1;
    });
    flow.getConditionCard('gateway_poe_active').registerRunListener(async ({ mac, port }) => {
      const status = await this.getGatewayPortStatus(mac, port);
      return Number(status.poe) > 0;
    });
    flow.getConditionCard('gateway_online_detection').registerRunListener(async ({ mac, port }) => {
      const status = await this.getGatewayPortStatus(mac, port);
      return Number(status.onlineDetection) > 0;
    });
    flow.getConditionCard('client_online').registerRunListener(async ({ device }) => device.isAvailable());
    flow.getConditionCard('client_online_mac').registerRunListener(async ({ mac }) => {
      const selectedMac = normalizeMac(mac);
      if (!selectedMac) return false;
      const siteId = await this.resolveSiteId();
      const clients = await this.getOmadaClient().listConnectedClients(siteId);
      return clients.some(client => normalizeMac(clientMac(client)) === selectedMac);
    });
    flow.getConditionCard('device_cpu_above').registerRunListener(async ({ device, percentage }) => {
      const value = Number(device.getSetting('cpu'));
      return Number.isFinite(value) && value >= Number(percentage);
    });
    flow.getConditionCard('device_memory_above').registerRunListener(async ({ device, percentage }) => {
      const value = Number(device.getSetting('memory'));
      return Number.isFinite(value) && value >= Number(percentage);
    });
    flow.getConditionCard('switch_port_power_above').registerRunListener(async ({ device, port, watts }) => {
      const row = await this.getSwitchPort(device, port);
      const value = Number(row.power ?? row.portStatus?.poePower);
      return Number.isFinite(value) && value >= Number(watts);
    });
    flow.getConditionCard('omada_device_online').registerRunListener(async ({ device }) => device.isAvailable());
    flow.getConditionCard('switch_port_connected').registerRunListener(async ({ device, port }) => {
      const row = await this.getSwitchPort(device, port);
      return Number(row.connectedStatus) === 0 || Number(row.portStatus?.linkStatus) === 1;
    });
    flow.getConditionCard('switch_poe_enabled').registerRunListener(async ({ device, port }) => {
      const row = await this.getSwitchPort(device, port);
      return Number(row.poe) === 1;
    });
    const matchesClient = (args, state) => {
      const selectedMac = normalizeMac(args.mac);
      return Boolean(selectedMac && selectedMac === normalizeMac(state?.mac));
    };
    for (const id of ['client_online_specific', 'client_offline_specific']) {
      const card = flow.getTriggerCard(id);
      card.registerRunListener(matchesClient);
    }
  }

  async resolveSiteId() {
    const configured = this.getOmadaSettings().siteId;
    if (configured) return configured;
    const sites = await this.getOmadaClient().listSites();
    if (sites.length !== 1) throw new Error('Kies een Omada-site in de appinstellingen.');
    return String(sites[0].siteId || sites[0].id);
  }

  async runClientFlowAction(method, mac) {
    const siteId = await this.resolveSiteId();
    await this.getOmadaClient()[method](siteId, mac);
    return true;
  }

  async runGatewayPoeAction(mac, port, enabled) {
    const siteId = await this.resolveSiteId();
    await this.getOmadaClient().setGatewayPoe(siteId, mac, port, enabled);
    return true;
  }

  async runGatewayWanAction(mac, port, connected, ipv6) {
    const siteId = await this.resolveSiteId();
    await this.getOmadaClient().setGatewayWanConnected(siteId, mac, port, connected, Boolean(ipv6));
    return true;
  }

  async runSwitchPortStateAction(mac, port, enabled) {
    const siteId = await this.resolveSiteId();
    await this.getOmadaClient().setSwitchPortEnabled(siteId, mac, port, enabled);
    return true;
  }

  async getGatewayPortStatus(mac, portNumber) {
    const siteId = await this.resolveSiteId();
    const gateway = await this.getOmadaClient().getGateway(siteId, mac);
    const port = (gateway.portStats || gateway.portStatus || []).find(item => String(item.port ?? item.portNumber ?? item.portId) === String(portNumber))
      || (gateway.portConfigs || gateway.portConfig || []).find(item => String(item.port ?? item.portNumber ?? item.portId) === String(portNumber))?.portStat;
    if (!port) throw new Error(`Gatewaypoort ${portNumber} is niet gevonden.`);
    return port;
  }

  async pollClientPresence() {
    const settings = this.getOmadaSettings();
    if (!settings.controllerUrl || !settings.omadacId || !settings.clientId || !settings.clientSecret) return;
    if (this.clientPollInProgress) return;
    this.clientPollInProgress = true;
    try {
      const siteId = await this.resolveSiteId();
      const clients = await this.getOmadaClient().listConnectedClients(siteId);
      const current = new Map(clients.map(client => {
        const mac = normalizeMac(clientMac(client));
        return [mac, {
          mac,
          name: String(client.name || client.clientName || client.hostName || clientMac(client) || mac),
          ip: String(client.ip || client.ipAddress || client.clientIp || ''),
        }];
      }).filter(([mac]) => Boolean(mac)));
      if (this.clientSnapshot) {
        const connected = this.homey.flow.getTriggerCard('client_connected');
        const disconnected = this.homey.flow.getTriggerCard('client_disconnected');
        const specificConnected = this.homey.flow.getTriggerCard('client_online_specific');
        const specificDisconnected = this.homey.flow.getTriggerCard('client_offline_specific');
        for (const [mac, client] of current) {
          if (!this.clientSnapshot.has(mac)) {
            await connected.trigger(client);
            await specificConnected.trigger(client, { mac, name: client.name });
          }
        }
        for (const [mac, client] of this.clientSnapshot) {
          if (!current.has(mac)) {
            await disconnected.trigger(client);
            await specificDisconnected.trigger(client, { mac, name: client.name });
          }
        }
      }
      this.clientSnapshot = current;
    } finally {
      this.clientPollInProgress = false;
    }
  }

  async getSwitchPort(device, port) {
    const { siteId, mac } = device.getData();
    if (!siteId || !mac) throw new Error('Het Omada-apparaat mist een Site ID of MAC-adres.');
    const rows = await this.getOmadaClient().listSwitchPortPoeInfo(siteId);
    const normalizedMac = String(mac).toLowerCase().replaceAll(':', '-');
    const row = rows.find(item => String(item.switchMac || '').toLowerCase().replaceAll(':', '-') === normalizedMac
      && String(item.port) === String(port));
    if (!row) throw new Error(`Poort ${port} is niet gevonden voor deze switch.`);
    return row;
  }

  async runPoeFlowAction(device, port, action) {
    const { siteId, mac } = device.getData();
    const switchMac = String(mac || '').replaceAll(':', '-').toUpperCase();
    try {
      // Resolve the user-facing port number against Omada's live port table.
      // This avoids assuming that a displayed port number is also the API port ID.
      const portRow = await this.getSwitchPort(device, port);
      const apiPort = Number(portRow.port);
      if (!Number.isInteger(apiPort) || apiPort < 0) {
        throw new Error(`Omada gaf geen geldig API-poortnummer terug voor poort ${port}.`);
      }
      if (action === 'herstellen') {
        await this.getOmadaClient().recoverSwitchPortsPoe(siteId, switchMac, [apiPort]);
      } else {
        // The controller also exposes a batch endpoint. Sending one selected
        // port through that documented route avoids differences in single-port
        // handling between controller builds.
        await this.getOmadaClient().updateSwitchPortPoe(siteId, switchMac, apiPort, action === 'aan');
      }
      return true;
    } catch (error) {
      const request = error.method && error.path ? `; verzoek: ${error.method} ${error.path}` : '';
      const body = error.requestBody ? `; gegevens: ${JSON.stringify(error.requestBody)}` : '';
      let portDetails = '';
      try {
        const row = await this.getSwitchPort(device, port);
        portDetails = `; poortinfo: ${JSON.stringify({
          port: row.port,
          standardPort: row.standardPort,
          portName: row.portName,
          supportPoe: row.supportPoe,
          switchMac: row.switchMac,
        })}`;
      } catch (lookupError) {
        portDetails = `; poortinfo niet beschikbaar: ${lookupError.message}`;
      }
      const details = `Omada-fout: ${error.message}; foutcode: ${error.errorCode ?? 'onbekend'}; HTTP: ${error.statusCode ?? 'onbekend'}${request}${body}${portDetails}`;
      this.error(`PoE ${action} mislukt voor switch ${switchMac}, poort ${port}: ${details}`);
      throw new Error(details);
    }
  }
};
