const { WebUSB, usb } = require('usb');

const ZUNE_VENDOR_ID = 0x045E;

const ZUNE_DEVICES = {
  0x063E: 'Zune HD',
  0x0710: 'Zune 32GB'
};

// Endpoint numbers for MTP bulk transfers (from Zune device descriptor)
const BULK_OUT_ENDPOINT = 1;
const BULK_IN_ENDPOINT = 1;

class UsbTransport {
  constructor() {
    this.device = null;
    this.webusb = new WebUSB({ allowAllDevices: true });
    this.attachCallbacks = [];
    this.detachCallbacks = [];
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

  async open(vendorId, productId) {
    const device = await this.webusb.requestDevice({
      filters: [{ vendorId, productId }]
    });

    if (!device) {
      throw new Error(`Zune device not found (VID=0x${vendorId.toString(16)}, PID=0x${productId.toString(16)})`);
    }

    this.device = device;
    await this.device.open();

    // Select configuration if not already active
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    await this.device.claimInterface(0);
  }

  async close() {
    if (this.device) {
      try {
        await this.device.releaseInterface(0);
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
  }

  async bulkWrite(data) {
    // WebUSB transferOut expects a BufferSource
    const result = await this.device.transferOut(BULK_OUT_ENDPOINT, data);
    if (result.status !== 'ok') {
      throw new Error(`USB bulk write failed: ${result.status}`);
    }
  }

  async bulkRead(length) {
    const result = await this.device.transferIn(BULK_IN_ENDPOINT, length);
    if (result.status !== 'ok') {
      throw new Error(`USB bulk read failed: ${result.status}`);
    }
    // Convert DataView to Buffer
    return Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  async clearHalt(direction) {
    try {
      const endpoint = direction === 'in'
        ? 'in' : 'out';
      await this.device.clearHalt(endpoint, direction === 'in' ? BULK_IN_ENDPOINT : BULK_OUT_ENDPOINT);
    } catch (err) {
      console.log('UsbTransport: clearHalt failed:', err.message);
    }
  }

  startHotplugDetection() {
    // Use the classic libusb API for hotplug events (WebUSB doesn't support them)
    usb.on('attach', (device) => {
      const { idVendor, idProduct } = device.deviceDescriptor;

      if (idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[idProduct]) {
        const info = { model: ZUNE_DEVICES[idProduct], productId: idProduct };

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
}

module.exports = { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES };
