'use strict';

function valueOf(device, keys) {
  for (const key of keys) {
    const value = device?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function isOnline(device) {
  const category = valueOf(device, ['statusCategory', 'status_category']);
  if (category !== undefined) return Number(category) === 1 || String(category).toLowerCase() === 'connected';
  const status = valueOf(device, ['status', 'deviceStatus', 'onlineStatus']);
  return status === 1 || status === true || ['online', 'connected', 'adopted'].includes(String(status).toLowerCase());
}

module.exports = { valueOf, isOnline };

