# Homey.OmadaIntegration

Local Homey app for an Omada Software Controller running in Docker (tested on Controller version 6.3.0.36).

## Functionality

The app provides Homey equivalents for the current Home Assistant TP-Link Omada integration:

- Switch, EAP, gateway, controller, and wireless client device information.
- Device status and diagnostics, switch PoE power measurement, firmware information, and firmware upgrade actions.
- Switch port status, PoE status/control, port enable/disable, and PoE recovery.
- Gateway WAN IPv4/IPv6 connection controls and PoE controls where supported.
- Wireless client presence triggers and client reconnect, block/unblock, and rename actions.
- Flow conditions for online clients/devices, CPU/memory thresholds, gateway link/WAN/PoE/online detection, and switch port state/power.
- A port-control widget for device/port selection, status, and supported controls.

Controller firmware installation is not offered for the Docker Software Controller; update the Docker image using your usual deployment process.

## Connection

The app uses the local Omada controller API. API client credentials provide Open API access; the local controller account is used for controller operations that require a logged-in session, including port configuration and client actions.
