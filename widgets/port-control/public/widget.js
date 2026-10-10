'use strict';

function initializeOmadaWidget(Homey) {
  const $ = id => document.getElementById(id);
  let currentDevice = null;
  let loading = false;

  const api = (method, path, body) => body === undefined
    ? Homey.api(method, path)
    : Homey.api(method, path, body);

  function typeGroup(value) {
    const type = String(value || '').toLowerCase();
    if (type.includes('switch')) return 'switch';
    if (type.includes('eap') || type.includes('access point') || type === 'ap') return 'eap';
    if (type.includes('gateway') || type.includes('router')) return 'gateway';
    return '';
  }

  function isOn(value) {
    return value === 1 || value === true || ['1', 'online', 'connected', 'adopted', 'up', 'active'].includes(String(value).toLowerCase());
  }

  function portNumber(port, index) {
    if (typeof port === 'number' || typeof port === 'string') return String(port);
    return String(port?.port ?? port?.portNumber ?? port?.portId ?? port?.lanPort ?? port?.name ?? index + 1);
  }

  function flag(value) {
    return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
  }

  function portEnabled(port) {
    if (port?.disabled !== undefined && port.disabled !== null) return !flag(port.disabled);
    if (port?.connectedStatus !== undefined && port.connectedStatus !== null) return Number(port.connectedStatus) !== 2;
    return true;
  }

  function poeEnabled(port) {
    const value = port?.poeStatus ?? port?.poeOutEnable ?? port?.poeMode ?? port?.poe;
    return value !== undefined && value !== null && isOn(value);
  }

  function updateToggle(button, label, enabled) {
    button.textContent = label;
    button.classList.toggle('is-on', enabled);
    button.classList.toggle('is-off', !enabled);
    button.setAttribute('aria-pressed', String(enabled));
  }

  function setButtons(enabled) {
    ['port-toggle', 'poe-toggle', 'poe-recover', 'wan-on', 'wan-off']
      .forEach(id => { $(id).disabled = !enabled || loading; });
  }

  function renderPort(port) {
    const link = port?.linkStatus ?? port?.status ?? port?.link ?? port?.up;
    const speed = port?.linkSpeed ?? port?.speed ?? port?.speedMbps;
    const speedNames = { 1: '10 Mbps', 2: '100 Mbps', 3: '1 Gbps', 4: '2,5 Gbps', 5: '10 Gbps' };
    const linked = link !== undefined && isOn(link);
    $('info-link').textContent = !port ? 'Geen poort geselecteerd'
      : `${linked ? 'Verbonden' : 'Niet verbonden'}${speed ? ` · ${speedNames[speed] || speed}` : ''}`;
    $('link-dot').className = `link-indicator ${!port ? '' : linked ? 'connected' : 'disconnected'}`;
    const poe = port?.poeStatus ?? port?.poeOutEnable ?? port?.poeMode ?? port?.poe;
    const draw = port?.power ?? port?.powerConsumption ?? port?.poePower;
    $('info-poe').textContent = `PoE ${poe === undefined ? '—' : isOn(poe) ? 'aan' : 'uit'}${draw !== undefined ? ` · ${draw} W` : ''}`;
  }

  function renderActions(device, port) {
    const type = typeGroup(device?.type);
    const hasPort = Boolean(device && port && !$('port').disabled);
    const switchPort = type === 'switch' && hasPort;
    const poePort = hasPort && port.poeSupported === true;
    const gatewayWan = type === 'gateway' && hasPort && port.isWan === true;
    $('port-actions').hidden = !switchPort;
    $('poe-actions').hidden = !poePort;
    $('recover-actions').hidden = !switchPort || !poePort;
    $('wan-actions').hidden = !gatewayWan;
    if (hasPort && switchPort) updateToggle($('port-toggle'), portEnabled(port) ? 'Poort aan' : 'Poort uit', portEnabled(port));
    if (hasPort && poePort) updateToggle($('poe-toggle'), poeEnabled(port) ? 'PoE aan' : 'PoE uit', poeEnabled(port));
    if (!device) $('action-note').textContent = 'Selecteer een apparaat in de widgetinstellingen.';
    else if (!hasPort) $('action-note').textContent = device.ports?.length ? 'Selecteer een poort om te bedienen.' : 'Geen poortinformatie beschikbaar.';
    else if (type === 'eap' && !poePort) $('action-note').textContent = 'Deze EAP-poort is alleen informatief.';
    else $('action-note').textContent = type === 'gateway' ? 'Beschikbare gatewayacties' : 'Kies een actie';
    setButtons(hasPort);
    if (!switchPort) ['port-toggle', 'poe-recover'].forEach(id => { $(id).disabled = true; });
    if (!poePort) $('poe-toggle').disabled = true;
    if (!gatewayWan) ['wan-on', 'wan-off'].forEach(id => { $(id).disabled = true; });
  }

  function renderDevice(device) {
    currentDevice = device || null;
    $('info-name').textContent = device?.name || 'Omada-poortbeheer';
    $('device-subtitle').textContent = device
      ? `${typeGroup(device.type).toUpperCase()}${device.model ? ` · ${device.model}` : ''}`
      : 'Kies een apparaat in de widgetinstellingen';
    $('info-model').textContent = device?.model || '—';
    $('info-ip').textContent = device?.ip || '—';
    $('info-mac').textContent = device?.mac || '—';
    const status = $('info-status');
    status.className = `status ${device ? (isOn(device.status) ? 'online' : 'offline') : ''}`;
    status.querySelector('span').textContent = device ? (isOn(device.status) ? 'Online' : 'Offline') : '—';
    const select = $('port');
    const ports = Array.isArray(device?.ports) ? device.ports : [];
    select.replaceChildren();
    if (!device) {
      select.add(new Option('Selecteer een apparaat in de widgetinstellingen', ''));
      select.disabled = true;
      renderPort(null);
      renderActions(null, null);
      return;
    }
    if (!ports.length) {
      select.add(new Option('Geen poortgegevens beschikbaar', ''));
      select.disabled = true;
      renderPort(null);
      renderActions(device, null);
      return;
    }
    ports.forEach((port, index) => select.add(new Option(`Poort ${port.portName || portNumber(port, index)}`, String(index))));
    select.disabled = false;
    select.value = '0';
    renderPort(ports[0]);
    renderActions(device, ports[0]);
  }

  async function load() {
    loading = true;
    setButtons(false);
    $('message').textContent = 'Apparaat- en poortgegevens ophalen…';
    try {
      const selectedIds = Homey.getDeviceIds();
      if (!Array.isArray(selectedIds) || !selectedIds.length) {
        throw new Error('Open widget bewerken → Instellingen en kies één Omada-apparaat.');
      }
      const result = await Promise.race([
        api('GET', `/device/${encodeURIComponent(selectedIds[0])}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('De Omada-controller reageert niet binnen 20 seconden.')), 20000)),
      ]);
      const device = result?.device;
      if (!device || !typeGroup(device.type)) throw new Error('Kies een gekoppelde Omada-switch, gateway of EAP.');
      renderDevice(device);
      $('message').textContent = 'Livegegevens bijgewerkt';
    } catch (error) {
      renderDevice(null);
      $('message').textContent = error?.message || 'Apparaatgegevens ophalen is mislukt.';
    } finally {
      loading = false;
      renderActions(currentDevice, currentDevice?.ports?.[Number($('port').value)]);
    }
  }

  async function runAction(label, method, path, body) {
    if (!currentDevice || $('port').disabled) return;
    const index = Number($('port').value);
    const port = currentDevice.ports[index];
    const type = typeGroup(currentDevice.type);
    const siteId = encodeURIComponent(currentDevice.siteId);
    const mac = encodeURIComponent(String(currentDevice.mac || '').replaceAll(':', '-'));
    const portId = encodeURIComponent(portNumber(port, index));
    loading = true;
    setButtons(false);
    $('message').textContent = `${label}…`;
    try {
      const requestBody = typeof body === 'function' ? body(port, portId) : body;
      await api(method, path(siteId, mac, portId, type), requestBody);
      $('message').textContent = `${label} uitgevoerd`;
      loading = false;
      await load();
    } catch (error) {
      $('message').textContent = error?.message || `${label} is mislukt.`;
    } finally {
      loading = false;
      renderActions(currentDevice, currentDevice?.ports?.[Number($('port').value)]);
    }
  }

  $('port').addEventListener('change', event => {
    const port = currentDevice?.ports?.[Number(event.target.value)];
    renderPort(port);
    renderActions(currentDevice, port);
  });
  $('port-toggle').addEventListener('click', () => {
    const enabled = !portEnabled(currentDevice?.ports?.[Number($('port').value)]);
    runAction(enabled ? 'Poort inschakelen' : 'Poort uitschakelen', 'PUT', (site, mac, port) => `/port/${site}/${mac}/${port}`, { enabled });
  });
  $('poe-toggle').addEventListener('click', () => {
    const enabled = !poeEnabled(currentDevice?.ports?.[Number($('port').value)]);
    runAction(enabled ? 'PoE inschakelen' : 'PoE uitschakelen', 'PUT', (site, mac, port, type) => `/poe/${type}/${site}/${mac}/${port}`, { enabled });
  });
  $('poe-recover').addEventListener('click', () => runAction('PoE herstellen', 'POST', (site, mac) => `/poe-recovery/${site}/${mac}`, (_, port) => ({ ports: [Number(port)] })));
  $('wan-on').addEventListener('click', () => runAction('WAN verbinden', 'PUT', (site, mac, port) => `/wan/${site}/${mac}/${port}`, { connected: true, ipv6: $('wan-ipv6').checked }));
  $('wan-off').addEventListener('click', () => runAction('WAN verbreken', 'PUT', (site, mac, port) => `/wan/${site}/${mac}/${port}`, { connected: false, ipv6: $('wan-ipv6').checked }));

  load();
}

window.initializeOmadaWidget = initializeOmadaWidget;
