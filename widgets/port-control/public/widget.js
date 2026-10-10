'use strict';

function onHomeyReady(Homey) {
  const $ = id => document.getElementById(id);
  let devices = [];
  let currentDevice = null;
  let loading = false;

  Homey.ready({ height: 280 });
  $('message').textContent = 'Verbinden met Omada…';

  function api(method, path, body) {
    return new Promise((resolve, reject) => {
      const callback = (error, result) => error ? reject(error) : resolve(result);
      if (body === undefined) Homey.api(method, path, callback);
      else Homey.api(method, path, body, callback);
    });
  }

  function typeGroup(value) {
    const type = String(value || '').toLowerCase();
    if (type.includes('switch')) return 'switch';
    if (type.includes('eap') || type.includes('access point') || type === 'ap') return 'eap';
    if (type.includes('gateway') || type.includes('router')) return 'gateway';
    return '';
  }

  function online(value) {
    return value === 1 || value === true || ['1', 'online', 'connected', 'adopted'].includes(String(value).toLowerCase());
  }

  function portNumber(port, index) {
    if (typeof port === 'number' || typeof port === 'string') return String(port);
    return String(port?.port ?? port?.portNumber ?? port?.portId ?? port?.lanPort ?? port?.name ?? index + 1);
  }

  function setButtons(enabled) {
    ['port-on', 'port-off', 'poe-on', 'poe-off', 'poe-recover', 'wan-on', 'wan-off']
      .forEach(id => { $(id).disabled = !enabled || loading; });
  }

  function renderPort(port, label) {
    $('info-port').textContent = label ? `Poort ${label}` : 'Selecteer een poort';
    if (!port || typeof port !== 'object') {
      $('info-link').textContent = '—';
      $('info-poe').textContent = '—';
      return;
    }
    const link = port.linkStatus ?? port.status ?? port.link ?? port.up;
    const speed = port.linkSpeed ?? port.speed ?? port.speedMbps;
    const speedNames = { 1: '10 Mbps', 2: '100 Mbps', 3: '1 Gbps', 4: '2,5 Gbps', 5: '10 Gbps' };
    $('info-link').textContent = `${link === undefined ? '—' : (online(link) ? 'Actief' : 'Inactief')}${speed ? ` · ${speedNames[speed] || speed}` : ''}`;
    const poe = port.poeStatus ?? port.poeOutEnable ?? port.poeMode ?? port.poe;
    const draw = port.power ?? port.powerConsumption ?? port.poePower;
    $('info-poe').textContent = `${poe === undefined ? '—' : (online(poe) ? 'Aan' : 'Uit')}${draw !== undefined ? ` · ${draw} W` : ''}`;
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
    if (!type) $('action-note').textContent = 'Dit Omada-apparaattype wordt niet ondersteund.';
    else if (!hasPort) $('action-note').textContent = device ? 'Voor dit apparaat zijn geen poorten beschikbaar.' : 'Selecteer een apparaat en poort.';
    else if (type === 'eap' && !poePort) $('action-note').textContent = 'Deze EAP-poort is alleen informatief.';
    else $('action-note').textContent = type === 'switch'
      ? 'Poort- en PoE-instellingen worden bijgewerkt via Omada.'
      : type === 'gateway' ? 'WAN- en PoE-bediening is beschikbaar voor deze gatewaypoort.' : 'PoE-uitvoer wordt bijgewerkt via Omada.';
    setButtons(hasPort);
    if (!switchPort) {
      $('port-on').disabled = true;
      $('port-off').disabled = true;
      $('poe-recover').disabled = true;
    }
    if (!poePort) {
      $('poe-on').disabled = true;
      $('poe-off').disabled = true;
    }
    if (!gatewayWan) {
      $('wan-on').disabled = true;
      $('wan-off').disabled = true;
    }
  }

  function renderDevice(device) {
    currentDevice = device || null;
    $('info-name').textContent = device?.name || 'Omada';
    $('info-model').textContent = device ? `${typeGroup(device.type).toUpperCase() || 'Omada'} · ${device.model || '—'}` : '—';
    $('info-ip').textContent = device?.ip || '—';
    $('info-mac').textContent = device?.mac || '—';
    $('info-firmware').textContent = device?.firmware || '—';
    const status = $('info-status');
    status.textContent = device ? (online(device.status) ? 'Online' : 'Offline') : '—';
    status.className = `status-pill ${device ? (online(device.status) ? 'online' : 'offline') : ''}`;
    const select = $('port');
    const ports = Array.isArray(device?.ports) ? device.ports : [];
    select.replaceChildren();
    if (!device) {
      select.add(new Option('Selecteer een apparaat', ''));
      select.disabled = true;
      renderPort(null, '');
      renderActions(null, null);
      return;
    }
    if (!ports.length) {
      select.add(new Option('Geen poortgegevens beschikbaar', ''));
      select.disabled = true;
      renderPort(null, '');
      renderActions(device, null);
      return;
    }
    ports.forEach((port, index) => select.add(new Option(`Poort ${port.portName || portNumber(port, index)}`, String(index))));
    select.disabled = false;
    select.value = '0';
    renderPort(ports[0], portNumber(ports[0], 0));
    renderActions(device, ports[0]);
  }

  async function load() {
    loading = true;
    setButtons(false);
    try {
      const result = await Promise.race([
        api('GET', '/devices'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Omada reageert niet binnen 20 seconden.')), 20000)),
      ]);
      devices = (result.devices || []).filter(device => typeGroup(device.type));
      const select = $('device');
      select.replaceChildren();
      if (!devices.length) {
        select.add(new Option(result.needsSiteId ? 'Vul Site ID in bij instellingen' : 'Geen Omada-apparaten gevonden', ''));
        renderDevice(null);
        $('message').textContent = result.needsSiteId ? 'Meerdere sites gevonden: stel een Site ID in bij de app.' : 'Controleer de verbinding en API-rechten.';
      } else {
        devices.forEach((device, index) => select.add(new Option(`${typeGroup(device.type).toUpperCase()} · ${device.name}`, String(index))));
        renderDevice(devices[0]);
        $('message').textContent = `${devices.length} apparaat${devices.length === 1 ? '' : 'en'} gevonden`;
      }
    } catch (error) {
      $('device').replaceChildren(new Option('Controller niet bereikbaar', ''));
      renderDevice(null);
      $('message').textContent = error.message || 'Verbinding met Omada mislukt.';
    } finally {
      loading = false;
      renderActions(currentDevice, currentDevice?.ports?.[Number($('port').value)]);
    }
  }

  async function runAction(label, method, path, body) {
    if (!currentDevice || $('port').disabled) return;
    const port = currentDevice.ports[Number($('port').value)];
    const type = typeGroup(currentDevice.type);
    const siteId = encodeURIComponent(currentDevice.siteId);
    const mac = encodeURIComponent(String(currentDevice.mac || '').replaceAll(':', '-'));
    const portId = encodeURIComponent(portNumber(port, Number($('port').value)));
    loading = true;
    setButtons(false);
    $('message').textContent = `${label} wordt uitgevoerd…`;
    try {
      const requestBody = typeof body === 'function' ? body(port, portId) : body;
      await api(method, path(siteId, mac, portId, type), requestBody);
      $('message').textContent = `${label} uitgevoerd voor poort ${portId}.`;
      loading = false;
      await load();
    } catch (error) {
      $('message').textContent = error.message || `${label} is mislukt.`;
    } finally {
      loading = false;
      renderActions(currentDevice, currentDevice?.ports?.[Number($('port').value)]);
    }
  }

  $('device').addEventListener('change', event => renderDevice(devices[Number(event.target.value)]));
  $('port').addEventListener('change', event => {
    const port = currentDevice?.ports?.[Number(event.target.value)];
    renderPort(port, port ? portNumber(port, Number(event.target.value)) : '');
    renderActions(currentDevice, port);
  });
  $('port-on').addEventListener('click', () => runAction('Poort inschakelen', 'PUT', (site, mac, port) => `/port/${site}/${mac}/${port}`, { enabled: true }));
  $('port-off').addEventListener('click', () => runAction('Poort uitschakelen', 'PUT', (site, mac, port) => `/port/${site}/${mac}/${port}`, { enabled: false }));
  $('poe-on').addEventListener('click', () => runAction('PoE inschakelen', 'PUT', (site, mac, port, type) => `/poe/${type}/${site}/${mac}/${port}`, { enabled: true }));
  $('poe-off').addEventListener('click', () => runAction('PoE uitschakelen', 'PUT', (site, mac, port, type) => `/poe/${type}/${site}/${mac}/${port}`, { enabled: false }));
  $('poe-recover').addEventListener('click', () => runAction('PoE herstellen', 'POST', (site, mac) => `/poe-recovery/${site}/${mac}`, (_, port) => ({ ports: [Number(port)] })));
  $('wan-on').addEventListener('click', () => runAction('WAN verbinden', 'PUT', (site, mac, port) => `/wan/${site}/${mac}/${port}`, { connected: true, ipv6: $('wan-ipv6').checked }));
  $('wan-off').addEventListener('click', () => runAction('WAN verbreken', 'PUT', (site, mac, port) => `/wan/${site}/${mac}/${port}`, { connected: false, ipv6: $('wan-ipv6').checked }));

  load();
}
