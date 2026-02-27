const { usb } = require('usb');

const ZUNE_VENDOR_ID = 0x045E;

const ZUNE_DEVICES = {
  0x063E: 'Zune HD',
  0x0710: 'Zune 32GB'
};

class UsbTransport {
  constructor() {
    this.device = null;
    this.iface = null;
    this.endpointIn = null;
    this.endpointOut = null;
    this.attachCallbacks = [];
    this.detachCallbacks = [];
  }

  findZune() {
    const devices = usb.getDeviceList();

    for (const device of devices) {
      const { idVendor, idProduct } = device.deviceDescriptor;

      if (idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[idProduct]) {
        return {
          device,
          model: ZUNE_DEVICES[idProduct],
          productId: idProduct
        };
      }
    }

    return null;
  }

  open(vendorId, productId) {
    const devices = usb.getDeviceList();
    this.device = devices.find((d) => {
      const desc = d.deviceDescriptor;
      return desc.idVendor === vendorId && desc.idProduct === productId;
    });

    if (!this.device) {
      throw new Error(`Zune device not found (VID=0x${vendorId.toString(16)}, PID=0x${productId.toString(16)})`);
    }

    this.device.open();

    this.iface = this.device.interface(0);

    if (this.iface.isKernelDriverActive()) {
      this.iface.detachKernelDriver();
    }

    this.iface.claim();

    for (const endpoint of this.iface.endpoints) {
      if (endpoint.transferType === usb.LIBUSB_TRANSFER_TYPE_BULK) {
        if (endpoint.direction === 'in') {
          this.endpointIn = endpoint;
        } else if (endpoint.direction === 'out') {
          this.endpointOut = endpoint;
        }
      }
    }

    if (!this.endpointIn || !this.endpointOut) {
      throw new Error('Could not find bulk IN and OUT endpoints');
    }
  }

  close() {
    try {
      if (this.iface) {
        this.iface.release();
      }
    } catch {
      // Ignore release errors
    }

    try {
      if (this.device) {
        this.device.close();
      }
    } catch {
      // Ignore close errors
    }

    this.device = null;
    this.iface = null;
    this.endpointIn = null;
    this.endpointOut = null;
  }

  bulkWrite(data) {
    return new Promise((resolve, reject) => {
      this.endpointOut.transfer(data, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  bulkRead(length) {
    return new Promise((resolve, reject) => {
      this.endpointIn.transfer(length, (error, data) => {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    });
  }

  startHotplugDetection() {
    usb.on('attach', (device) => {
      const { idVendor, idProduct } = device.deviceDescriptor;

      if (idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[idProduct]) {
        const info = { device, model: ZUNE_DEVICES[idProduct], productId: idProduct };

        for (const callback of this.attachCallbacks) {
          callback(info);
        }
      }
    });

    usb.on('detach', (device) => {
      const { idVendor, idProduct } = device.deviceDescriptor;

      if (idVendor === ZUNE_VENDOR_ID && ZUNE_DEVICES[idProduct]) {
        const info = { device, model: ZUNE_DEVICES[idProduct], productId: idProduct };

        for (const callback of this.detachCallbacks) {
          callback(info);
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
