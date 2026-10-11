'use strict';

const http = require('http');
const https = require('https');

class OmadaApiError extends Error {
  constructor(message, statusCode, errorCode, method, path, requestBody) {
    super(message);
    this.name = 'OmadaApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.method = method;
    this.path = path;
    this.requestBody = requestBody;
  }
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Vul het controlleradres in.');
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Gebruik een http- of https-adres.');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function resultData(payload) {
  return payload && payload.result !== undefined ? payload.result : payload;
}

function normalizeSwitchMac(value) {
  return String(value || '').trim().replaceAll(':', '-').toUpperCase();
}

class OmadaClient {
  constructor(settings, logger = () => {}) {
    this.settings = settings;
    this.logger = logger;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.webSession = null;
  }

  get baseUrl() {
    return normalizeBaseUrl(this.settings.controllerUrl);
  }

  get configured() {
    return Boolean(
      this.settings.controllerUrl
      && this.settings.omadacId
      && this.settings.clientId
      && this.settings.clientSecret,
    );
  }

  _request(method, path, { body, authenticated = true } = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      if (!this.accessToken) throw new Error('Omada API-token ontbreekt.');
      headers.Authorization = `AccessToken=${this.accessToken}`;
    }

    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method,
        headers,
        timeout: 15000,
        ...(url.protocol === 'https:' && this.settings.allowSelfSigned
          ? { rejectUnauthorized: false }
          : {}),
      }, response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { raw += chunk; });
        response.on('end', () => {
          let payload;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new OmadaApiError(`Omada gaf geen geldige JSON terug (HTTP ${response.statusCode}).`, response.statusCode, undefined, method, url.pathname, body));
            return;
          }

          const apiError = payload && Number(payload.errorCode) !== 0;
          if ((response.statusCode < 200 || response.statusCode >= 300) || apiError) {
            const message = payload?.msg || payload?.message || `HTTP ${response.statusCode}`;
            reject(new OmadaApiError(message, response.statusCode, payload?.errorCode, method, url.pathname, body));
            return;
          }
          resolve(payload);
        });
      });

      request.on('timeout', () => request.destroy(new Error('De verbinding met Omada duurde te lang.')));
      request.on('error', reject);
      if (body !== undefined) request.write(JSON.stringify(body));
      request.end();
    });
  }

  _requestWithHeaders(method, path, { body, headers: extraHeaders = {}, captureHeaders = false, includeRequestBody = true } = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json', ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method,
        headers,
        timeout: 15000,
        ...(url.protocol === 'https:' && this.settings.allowSelfSigned
          ? { rejectUnauthorized: false }
          : {}),
      }, response => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { raw += chunk; });
        response.on('end', () => {
          let payload;
          try {
            payload = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new OmadaApiError(`Omada gaf geen geldige JSON terug (HTTP ${response.statusCode}).`, response.statusCode, undefined, method, url.pathname, includeRequestBody ? body : undefined));
            return;
          }
          const apiError = payload && Number(payload.errorCode) !== 0;
          if (response.statusCode < 200 || response.statusCode >= 300 || apiError) {
            reject(new OmadaApiError(payload?.msg || payload?.message || `HTTP ${response.statusCode}`, response.statusCode, payload?.errorCode, method, url.pathname, includeRequestBody ? body : undefined));
            return;
          }
          resolve(captureHeaders ? { payload, headers: response.headers } : payload);
        });
      });
      request.on('timeout', () => request.destroy(new Error('De verbinding met Omada duurde te lang.')));
      request.on('error', reject);
      if (body !== undefined) request.write(JSON.stringify(body));
      request.end();
    });
  }

  async authenticateWebSession() {
    if (!this.settings.controllerUsername || !this.settings.controllerPassword) {
      throw new Error('Voor PoE-bediening is ook een lokale Omada-gebruikersnaam en wachtwoord nodig. Vul die in bij de appinstellingen.');
    }
    const response = await this._requestWithHeaders(
      'POST',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/login`,
      {
        body: {
          username: String(this.settings.controllerUsername).trim(),
          password: String(this.settings.controllerPassword),
        },
        captureHeaders: true,
        includeRequestBody: false,
      },
    );
    const result = resultData(response.payload);
    const cookies = (response.headers['set-cookie'] || []).map(value => value.split(';', 1)[0]).filter(Boolean);
    if (!result?.token || cookies.length === 0) {
      throw new Error('Omada heeft geen geldige lokale sessie teruggestuurd. Controleer de controllerlogin.');
    }
    this.webSession = {
      token: result.token,
      cookies,
      expiresAt: Date.now() + (50 * 60 * 1000),
    };
    return this.webSession;
  }

  async requestWebApi(method, path, options = {}) {
    if (!this.webSession || Date.now() >= this.webSession.expiresAt) await this.authenticateWebSession();
    const headers = {
      Cookie: this.webSession.cookies.join('; '),
      'Csrf-Token': this.webSession.token,
      'Omada-Request-Source': 'web-local',
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
    };
    try {
      return await this._requestWithHeaders(method, path, { ...options, headers });
    } catch (error) {
      if (error instanceof OmadaApiError && (error.errorCode === -30109 || error.errorCode === -30110)) {
        this.webSession = null;
        await this.authenticateWebSession();
        return this._requestWithHeaders(method, path, {
          ...options,
          headers: {
            Cookie: this.webSession.cookies.join('; '),
            'Csrf-Token': this.webSession.token,
            'Omada-Request-Source': 'web-local',
            Referer: `${this.baseUrl}/`,
            Origin: this.baseUrl,
          },
        });
      }
      throw error;
    }
  }

  async authenticate() {
    if (!this.configured) throw new Error('Vul de Omada API-instellingen in bij de appinstellingen.');
    const payload = await this._request(
      'POST',
      '/openapi/authorize/token?grant_type=client_credentials',
      {
        authenticated: false,
        body: {
          omadacId: String(this.settings.omadacId).trim(),
          client_id: String(this.settings.clientId).trim(),
          client_secret: String(this.settings.clientSecret),
        },
      },
    );
    const token = resultData(payload);
    if (!token?.accessToken || !token?.expiresIn) {
      throw new Error('Omada heeft geen geldig access-token teruggestuurd.');
    }
    this.accessToken = token.accessToken;
    this.tokenExpiresAt = Date.now() + (Number(token.expiresIn) - 60) * 1000;
    return token;
  }

  async request(method, path, options = {}) {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) await this.authenticate();
    try {
      return await this._request(method, path, options);
    } catch (error) {
      // Omada invalidates existing tokens when an Open API app's role or site
      // privileges change. Some controller versions report that stale token as
      // -1505 (site access denied), so refresh once before surfacing the error.
      if (error instanceof OmadaApiError && (error.statusCode === 401 || [-1505, -44112, -44113].includes(error.errorCode))) {
        this.accessToken = null;
        await this.authenticate();
        return this._request(method, path, options);
      }
      throw error;
    }
  }

  async listSites() {
    const payload = await this.request(
      'GET',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites?page=1&pageSize=100`,
    );
    const result = resultData(payload);
    return Array.isArray(result) ? result : (result?.data || []);
  }

  async listDevices(siteId = this.settings.siteId) {
    if (!siteId) throw new Error('Kies eerst een Omada-site.');
    const payload = await this.request(
      'GET',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/devices?page=1&pageSize=100`,
    );
    const result = resultData(payload);
    return Array.isArray(result) ? result : (result?.data || []);
  }

  async listClients(siteId = this.settings.siteId) {
    if (!siteId) throw new Error('Kies eerst een Omada-site.');
    const payload = await this.request(
      'GET',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/clients?page=1&pageSize=100`,
    );
    const result = resultData(payload);
    return Array.isArray(result) ? result : (result?.data || []);
  }

  async listKnownClients(siteId = this.settings.siteId) {
    if (!siteId) throw new Error('Kies eerst een Omada-site.');
    const allClients = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
      const payload = await this.requestWebApi(
        'GET',
        `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/insight/clients?currentPage=${page}&currentPageSize=${pageSize}`,
      );
      const result = resultData(payload);
      const clients = Array.isArray(result) ? result : (result?.data || []);
      allClients.push(...clients);
      const totalRows = Number(result?.totalRows);
      if (clients.length === 0 || clients.length < pageSize
        || (Number.isFinite(totalRows) && allClients.length >= totalRows)) break;
      page += 1;
    }
    return allClients;
  }

  async listConnectedClients(siteId = this.settings.siteId) {
    if (!siteId) throw new Error('Kies eerst een Omada-site.');
    const allClients = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
      const payload = await this.request(
        'GET',
        `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/clients?page=${page}&pageSize=${pageSize}&filters.active=true`,
      );
      const result = resultData(payload);
      const clients = Array.isArray(result) ? result : (result?.data || []);
      allClients.push(...clients);
      const totalRows = Number(result?.totalRows);
      if (clients.length === 0 || clients.length < pageSize
        || (Number.isFinite(totalRows) && allClients.length >= totalRows)) break;
      page += 1;
    }
    return allClients;
  }

  async runClientCommand(siteId, mac, command) {
    if (!siteId || !mac) throw new Error('Site ID en MAC-adres zijn nodig voor deze clientactie.');
    if (!['reconnect', 'block', 'unblock'].includes(command)) throw new Error('Onbekende clientactie.');
    return this.requestWebApi(
      'POST',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/cmd/clients/${encodeURIComponent(normalizeSwitchMac(mac))}/${command}`,
    );
  }

  async reconnectClient(siteId, mac) {
    return this.runClientCommand(siteId, mac, 'reconnect');
  }

  async blockClient(siteId, mac) {
    return this.runClientCommand(siteId, mac, 'block');
  }

  async unblockClient(siteId, mac) {
    return this.runClientCommand(siteId, mac, 'unblock');
  }

  async setClientName(siteId, mac, name) {
    if (!siteId || !mac || !String(name || '').trim()) {
      throw new Error('Site ID, MAC-adres en een clientnaam zijn nodig.');
    }
    return this.requestWebApi(
      'PATCH',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/clients/${encodeURIComponent(normalizeSwitchMac(mac))}`,
      { body: { name: String(name).trim() } },
    );
  }

  async getFirmwareInfo(siteId, mac) {
    if (!siteId || !mac) throw new Error('Site ID en MAC-adres zijn nodig om firmwaregegevens op te halen.');
    const payload = await this.requestWebApi(
      'GET',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/devices/${encodeURIComponent(normalizeSwitchMac(mac))}/firmware`,
    );
    return resultData(payload);
  }

  async startFirmwareUpgrade(siteId, mac) {
    if (!siteId || !mac) throw new Error('Site ID en MAC-adres zijn nodig om firmware bij te werken.');
    const normalizedMac = normalizeSwitchMac(mac);
    return this.requestWebApi(
      'POST',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/cmd/devices/${encodeURIComponent(normalizedMac)}/onlineUpgrade`,
      { body: { mac: normalizedMac } },
    );
  }

  async getGateway(siteId, mac) {
    if (!siteId || !mac) throw new Error('Site ID en MAC-adres zijn nodig.');
    const payload = await this.requestWebApi(
      'GET',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/gateways/${encodeURIComponent(normalizeSwitchMac(mac))}`,
    );
    return resultData(payload);
  }

  async getAccessPoint(siteId, mac) {
    if (!siteId || !mac) throw new Error('Site ID en MAC-adres zijn nodig.');
    const payload = await this.requestWebApi(
      'GET',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/eaps/${encodeURIComponent(normalizeSwitchMac(mac))}`,
    );
    return resultData(payload);
  }

  async setAccessPointPortPoe(siteId, mac, portName, enabled) {
    const accessPoint = await this.getAccessPoint(siteId, mac);
    const portSettings = accessPoint.lanPortSettings || [];
    const selectedPort = portSettings.find(port => String(port.lanPort || port.id) === String(portName));
    if (!selectedPort) throw new Error(`EAP-poort ${portName} is niet gevonden.`);
    if (!selectedPort.supportPoe) throw new Error(`EAP-poort ${portName} ondersteunt geen PoE-uitvoer.`);
    const body = {
      lanPortSettings: [{
        id: selectedPort.id || selectedPort.lanPort,
        lanPort: selectedPort.lanPort || selectedPort.id,
        localVlanEnable: Boolean(selectedPort.localVlanEnable),
        localVlanId: Number(selectedPort.localVlanId ?? -1),
        poeOutEnable: Boolean(enabled),
      }],
    };
    return this.requestWebApi(
      'PATCH',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/eaps/${encodeURIComponent(normalizeSwitchMac(mac))}`,
      { body },
    );
  }

  async getControllerInfo() {
    const payload = await this._requestWithHeaders('GET', '/api/info');
    return resultData(payload);
  }

  async getControllerStatus() {
    const payload = await this.requestWebApi(
      'GET',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/maintenance/controllerStatus`,
    );
    return resultData(payload);
  }

  async getControllerUpdateInfo() {
    const payload = await this.requestWebApi(
      'GET',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/controller/notification/updateInfo`,
    );
    return resultData(payload);
  }

  async setGatewayPoe(siteId, mac, portNumber, enabled) {
    const gateway = await this.getGateway(siteId, mac);
    const ports = gateway.portConfigs || gateway.portConfig || [];
    const gatewayPortNumber = port => port.port ?? port.portNumber ?? port.portId;
    const selectedPort = ports.find(port => String(gatewayPortNumber(port)) === String(portNumber));
    if (!selectedPort) throw new Error(`Gatewaypoort ${portNumber} is niet gevonden.`);
    const poePorts = ports.filter(port => {
      const mode = port.poeMode ?? port.poe;
      return port.supportPoe !== false && mode !== undefined && mode !== null
        && !['NONE', 'NOT_SUPPORT', '-1'].includes(String(mode).toUpperCase());
    });
    if (!poePorts.some(port => String(gatewayPortNumber(port)) === String(portNumber))) {
      throw new Error(`Gatewaypoort ${portNumber} ondersteunt geen PoE.`);
    }
    const body = {
      lldpEnable: Boolean(gateway.lldpEnable),
      echoServer: gateway.echoServer || '0.0.0.0',
      poeSettings: poePorts.map(port => ({
        enable: String(gatewayPortNumber(port)) === String(portNumber)
          ? Boolean(enabled)
          : Number(port.poeMode ?? port.poe) === 1 || (port.poeMode ?? port.poe) === true,
        portId: Number(gatewayPortNumber(port)),
      })),
    };
    return this.requestWebApi(
      'PATCH',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/gateways/${encodeURIComponent(normalizeSwitchMac(mac))}`,
      { body },
    );
  }

  async setGatewayWanConnected(siteId, mac, portNumber, connected, ipv6 = false) {
    if (!siteId || !mac || portNumber === undefined || portNumber === null) {
      throw new Error('Site ID, gateway-MAC en poortnummer zijn nodig.');
    }
    return this.requestWebApi(
      'POST',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/cmd/gateways/${encodeURIComponent(normalizeSwitchMac(mac))}/${ipv6 ? 'ipv6State' : 'internetState'}`,
      { body: { portId: Number(portNumber), operation: connected ? 1 : 0 } },
    );
  }

  async listSwitchPortPoeInfo(siteId = this.settings.siteId) {
    if (!siteId) throw new Error('Kies eerst een Omada-site.');
    const allPorts = [];
    const pageSize = 1000;
    let page = 1;
    while (true) {
      const payload = await this.request(
        'GET',
        `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/switches/ports/poe-info?page=${page}&pageSize=${pageSize}`,
      );
      const result = resultData(payload);
      const ports = Array.isArray(result) ? result : (result?.data || []);
      allPorts.push(...ports);
      const totalRows = Number(result?.totalRows);
      if (ports.length === 0 || ports.length < pageSize || (Number.isFinite(totalRows) && allPorts.length >= totalRows)) break;
      page += 1;
    }
    return allPorts;
  }

  async getSwitchPortConfiguration(siteId, switchMac, port) {
    const payload = await this.requestWebApi(
      'GET',
      `/${encodeURIComponent(this.settings.omadacId)}/api/v2/sites/${encodeURIComponent(siteId)}/switches/${encodeURIComponent(normalizeSwitchMac(switchMac))}/ports/${encodeURIComponent(String(port))}`,
    );
    return resultData(payload);
  }

  async getSwitchPortProfile(siteId, profileId) {
    const payload = await this.requestWebApi(
      'GET',
      `/openapi/v2/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/lan-profiles?page=1&pageSize=100`,
    );
    const result = resultData(payload);
    const profiles = Array.isArray(result) ? result : (result?.data || []);
    return profiles.find(profile => String(profile.id || profile.profileId) === String(profileId)) || null;
  }

  async updateSwitchPortPoe(siteId, switchMac, portNumber, enabled, portEnabled) {
    if (!siteId || !switchMac || portNumber === undefined || portNumber === null || portNumber === '') {
      throw new Error('Site, switch-MAC en poort zijn nodig om PoE te bedienen.');
    }
    const mac = normalizeSwitchMac(switchMac);
    const port = await this.getSwitchPortConfiguration(siteId, mac, portNumber);
    if (!port || !port.profileId) throw new Error('Omada gaf geen volledige poortconfiguratie terug.');

    const profileOverrideEnabled = Boolean(port.profileOverrideEnable);
    let profile = null;
    if (!profileOverrideEnabled) {
      profile = await this.getSwitchPortProfile(siteId, port.profileId);
      if (!profile) throw new Error('Het huidige poortprofiel kon niet worden opgehaald; PoE is niet gewijzigd.');
    }
    const current = key => profileOverrideEnabled ? port[key] : profile[key];
    const body = {
      name: port.name,
      profileId: port.profileId,
      linkSpeed: port.linkSpeed,
      duplex: port.duplex,
      profileOverrideEnable: true,
      tagIds: port.tagIds || [],
      operation: 'switching',
      bandWidthCtrlType: 0,
      poe: enabled ? 1 : 0,
      lldpMedEnable: Boolean(current('lldpMedEnable')),
      loopbackDetectEnable: Boolean(current('loopbackDetectEnable')),
      spanningTreeEnable: Boolean(current('spanningTreeEnable')),
      portIsolationEnable: Boolean(current('portIsolationEnable')),
      dhcpL2RelaySettings: { enable: false },
    };
    if (portEnabled !== undefined) body.disable = !Boolean(portEnabled);
    if (port.nativeNetworkId) body.nativeNetworkId = port.nativeNetworkId;
    if (port.networkTagsSetting !== undefined) body.networkTagsSetting = port.networkTagsSetting;
    if (Array.isArray(port.tagNetworkIds)) body.tagNetworkIds = port.tagNetworkIds;
    if (Array.isArray(port.untagNetworkIds)) body.untagNetworkIds = port.untagNetworkIds;
    if (port.voiceNetworkEnable !== undefined) {
      body.voiceNetworkEnable = port.voiceNetworkEnable;
      if (port.voiceNetworkEnable && port.voiceNetworkId) body.voiceNetworkId = port.voiceNetworkId;
    }
    if (current('dot1x') !== undefined && current('dot1x') !== null) body.dot1x = current('dot1x');
    if (current('eeeEnable') !== undefined) body.eeeEnable = Boolean(current('eeeEnable'));
    if (current('flowControlEnable') !== undefined) body.flowControlEnable = Boolean(current('flowControlEnable'));
    if (current('loopbackDetectVlanBasedEnable') !== undefined) {
      body.loopbackDetectVlanBasedEnable = Boolean(current('loopbackDetectVlanBasedEnable'));
    }

    return this.requestWebApi(
      'PATCH',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/switches/${encodeURIComponent(mac)}/ports/${encodeURIComponent(String(portNumber))}`,
      { body },
    );
  }

  async setSwitchPortEnabled(siteId, switchMac, portNumber, enabled) {
    const port = await this.getSwitchPortConfiguration(siteId, switchMac, portNumber);
    let poeEnabled = Number(port.poe) === 1 || port.poe === true;
    if (!port.profileOverrideEnable && port.profileId) {
      const profile = await this.getSwitchPortProfile(siteId, port.profileId);
      if (profile) poeEnabled = Number(profile.poe) === 1 || profile.poe === true;
    }
    return this.updateSwitchPortPoe(siteId, switchMac, portNumber, poeEnabled, enabled);
  }

  async setSwitchPortPoeMode(siteId, switchMac, port, enabled) {
    if (!siteId || !switchMac || port === undefined || port === null || port === '') {
      throw new Error('Site, switch-MAC en poort zijn nodig om PoE te bedienen.');
    }
    return this.request(
      'PUT',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/switches/${encodeURIComponent(normalizeSwitchMac(switchMac))}/ports/${encodeURIComponent(String(port))}/poe-mode`,
      { body: { poeMode: enabled ? 1 : 0 } },
    );
  }

  async setSwitchPortsPoeMode(siteId, switchMac, ports, enabled) {
    if (!siteId || !switchMac || !Array.isArray(ports) || ports.length === 0) {
      throw new Error('Site, switch-MAC en minimaal één poort zijn nodig om PoE te bedienen.');
    }
    return this.request(
      'PUT',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/switches/${encodeURIComponent(normalizeSwitchMac(switchMac))}/multi-ports/poe-mode`,
      { body: { portList: ports, poeMode: enabled ? 1 : 0 } },
    );
  }

  async recoverSwitchPortsPoe(siteId, switchMac, ports) {
    if (!siteId || !switchMac || !Array.isArray(ports) || ports.length === 0) {
      throw new Error('Site, switch-MAC en minimaal één poort zijn nodig voor PoE-herstel.');
    }
    return this.request(
      'POST',
      `/openapi/v1/${encodeURIComponent(this.settings.omadacId)}/sites/${encodeURIComponent(siteId)}/switches/${encodeURIComponent(normalizeSwitchMac(switchMac))}/multi-ports/poe-recovery`,
      { body: { ports } },
    );
  }
}

module.exports = { OmadaClient, OmadaApiError, normalizeBaseUrl };
