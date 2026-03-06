const { WebUSB, usb } = require('usb');
const { WebUSBDevice } = require('usb/dist/webusb/webusb-device');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const ZUNE_VENDOR_ID = 0x045E;

const ZUNE_DEVICES = {
  0x063E: 'Zune HD',
  0x0710: 'Zune 30'
};

class UsbTransport {
  constructor() {
    this.device = null;
    this.webusb = new WebUSB({ allowAllDevices: true });
    this.attachCallbacks = [];
    this.detachCallbacks = [];
    this.bulkOutEndpoint = null;
    this.bulkInEndpoint = null;
    this.mtpInterface = null;
  }

  async findZune() {
    try {
      const device = await this.webusb.requestDevice({
        filters: Object.keys(ZUNE_DEVICES).map(pid => ({
          vendorId: ZUNE_VENDOR_ID,
          productId: Number(pid)
        }))
      });
      if (device) {
        const model = ZUNE_DEVICES[device.productId] || 'Zune';
        return { device, model, productId: device.productId };
      }
    } catch {
      // No matching device found
    }
    return null;
  }

  /**
   * Discover MTP interface and bulk endpoints from device configuration.
   * MTP uses class 6 (Still Image / PTP), subclass 1, protocol 1.
   * Falls back to first interface with bulk in+out endpoints.
   */
  _discoverEndpoints() {
    const config = this.device.configuration;
    if (!config) throw new Error('No active USB configuration');

    console.log(`UsbTransport: configuration ${config.configurationValue}, ${config.interfaces.length} interface(s)`);

    let mtpIface = null;

    // First pass: look for MTP/PTP class (6/1/1)
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        console.log(`UsbTransport:   interface ${iface.interfaceNumber} alt ${alt.alternateSetting}: class=${alt.interfaceClass} sub=${alt.interfaceSubclass} proto=${alt.interfaceProtocol} endpoints=${alt.endpoints.length}`);
        if (alt.interfaceClass === 6 && alt.interfaceSubclass === 1 && alt.interfaceProtocol === 1) {
          mtpIface = { iface, alt };
          break;
        }
      }
      if (mtpIface) break;
    }

    // Second pass: fall back to first interface with bulk in+out
    if (!mtpIface) {
      for (const iface of config.interfaces) {
        for (const alt of iface.alternates) {
          const hasIn = alt.endpoints.some(e => e.direction === 'in' && e.type === 'bulk');
          const hasOut = alt.endpoints.some(e => e.direction === 'out' && e.type === 'bulk');
          if (hasIn && hasOut) {
            mtpIface = { iface, alt };
            break;
          }
        }
        if (mtpIface) break;
      }
    }

    if (!mtpIface) throw new Error('No MTP interface found on device');

    const { iface, alt } = mtpIface;
    this.mtpInterface = iface.interfaceNumber;

    for (const ep of alt.endpoints) {
      if (ep.type === 'bulk' && ep.direction === 'out') {
        this.bulkOutEndpoint = ep.endpointNumber;
      } else if (ep.type === 'bulk' && ep.direction === 'in') {
        this.bulkInEndpoint = ep.endpointNumber;
      }
    }

    if (this.bulkOutEndpoint === null || this.bulkInEndpoint === null) {
      throw new Error('MTP interface missing bulk endpoints');
    }

    console.log(`UsbTransport: MTP interface=${this.mtpInterface} bulkOut=${this.bulkOutEndpoint} bulkIn=${this.bulkInEndpoint}`);
  }

  async _openAndClaim() {
    await this.device.open();

    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    this._discoverEndpoints();
    await this.device.claimInterface(this.mtpInterface);
  }

  async open(vendorId, productId) {
    let device = null;
    try {
      device = await this.webusb.requestDevice({
        filters: [{ vendorId, productId }]
      });
    } catch {
      // requestDevice fails for hotplugged devices
    }

    if (!device) {
      throw new Error(`Zune device not found (VID=0x${vendorId.toString(16)}, PID=0x${productId.toString(16)})`);
    }

    this.device = device;
    await this._openAndClaim();
  }

  /**
   * Open using a libusb Device object directly (for hotplug).
   * Wraps it in a WebUSBDevice so the rest of the transport API works.
   */
  async openFromLibusb(libusbDevice) {
    this.device = await WebUSBDevice.createInstance(libusbDevice);
    await this._openAndClaim();
  }

  async close() {
    if (this.device) {
      try {
        if (this.mtpInterface !== null) {
          await this.device.releaseInterface(this.mtpInterface);
        }
      } catch {
        // Ignore release errors
      }
      try {
        await this.device.close();
      } catch {
        // Ignore close errors
      }
    }
    this.device = null;
    this.bulkOutEndpoint = null;
    this.bulkInEndpoint = null;
    this.mtpInterface = null;
  }

  async bulkWrite(data) {
    const result = await this.device.transferOut(this.bulkOutEndpoint, data);
    if (result.status !== 'ok') {
      throw new Error(`USB bulk write failed: ${result.status}`);
    }
  }

  async bulkRead(length) {
    const result = await this.device.transferIn(this.bulkInEndpoint, length);
    if (result.status !== 'ok') {
      throw new Error(`USB bulk read failed: ${result.status}`);
    }
    return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  async clearHalt(direction) {
    try {
      const epNum = direction === 'in' ? this.bulkInEndpoint : this.bulkOutEndpoint;
      await this.device.clearHalt(direction, epNum);
    } catch (err) {
      console.log('UsbTransport: clearHalt failed:', err.message);
    }
  }

  startHotplugDetection() {
    usb.on('attach', (device) => {
      const { idVendor, idProduct } = device.deviceDescriptor;

      if (idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[idProduct]) {
        const info = { model: ZUNE_DEVICES[idProduct], productId: idProduct, libusbDevice: device };

        for (const callback of this.attachCallbacks) {
          callback(info);
        }
      }
    });

    usb.on('detach', (device) => {
      const { idVendor, idProduct } = device.deviceDescriptor;

      if (idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[idProduct]) {
        for (const callback of this.detachCallbacks) {
          callback();
        }
      }
    });
  }

  stopHotplugDetection() {
    usb.removeAllListeners('attach');
    usb.removeAllListeners('detach');
  }

  onAttach(callback) {
    this.attachCallbacks.push(callback);
  }

  onDetach(callback) {
    this.detachCallbacks.push(callback);
  }

  /**
   * Windows-only: check if a Zune device is visible in Device Manager but
   * inaccessible to libusb (i.e. it's using the Windows MTP driver instead of
   * WinUSB). Returns true when a Zune VID is found via PnP but findZune() would
   * return nothing, indicating a driver switch is needed.
   */
  async detectMissingDriver() {
    if (process.platform !== 'win32') return false;

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$count = (Get-PnpDevice | Where-Object { $_.HardwareID -and ($_.HardwareID -join ',') -match 'VID_045E' } | Measure-Object).Count; Write-Output $count`
      ], { timeout: 8000 });

      const count = parseInt(stdout.trim(), 10);
      return count > 0;
    } catch (_) {
      return false;
    }
  }
}

module.exports = { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES };
