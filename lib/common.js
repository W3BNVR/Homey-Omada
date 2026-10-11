'use strict';

function valueOf(device, keys) {
  for (const key of keys) {
    const value = device?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeMac(mac) {
  const normalized = String(mac || '').trim().toUpperCase().replace(/[:-]/g, '');
  return /^[0-9A-F]{12}$/.test(normalized) ? normalized : '';
}

function clientMac(client) {
  return valueOf(client, ['mac', 'macAddress', 'clientMac']);
}

function isOnline(device) {
  const status = valueOf(device, ['status', 'deviceStatus', 'onlineStatus']);
  return status === 1 || status === true || ['online', 'connected', 'adopted'].includes(String(status).toLowerCase());
}

module.exports = { valueOf, isOnline, normalizeMac, clientMac };
