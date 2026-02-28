const { UsbTransport, ZUNE_VENDOR_ID, ZUNE_DEVICES } = require('./src/main/zune/usb-transport');
const { MtpProtocol } = require('./src/main/zune/mtp-protocol');

async function main() {
  const transport = new UsbTransport();

  console.log('Looking for Zune...');
  const found = await transport.findZune();

  if (!found) {
    console.log('No Zune found. Make sure it is plugged in.');
    process.exit(1);
  }

  console.log(`Found: ${found.model} (PID=0x${found.productId.toString(16)})`);
  await transport.open(ZUNE_VENDOR_ID, found.productId);
  console.log('USB device opened, interface claimed.');

  const mtp = new MtpProtocol(transport);

  console.log('Opening MTP session...');
  await mtp.openSession(1);
  console.log('Session opened successfully!');

  console.log('Getting device info...');
  const info = await mtp.getDeviceInfo();
  console.log('Device info:', JSON.stringify(info, null, 2));

  console.log('Getting storage IDs...');
  const storageIds = await mtp.getStorageIDs();
  console.log('Storage IDs:', storageIds.map(id => '0x' + id.toString(16)));

  if (storageIds.length > 0) {
    console.log('Getting storage info for first storage...');
    const storageInfo = await mtp.getStorageInfo(storageIds[0]);
    console.log('Storage info:', JSON.stringify(storageInfo, null, 2));
  }

  console.log('Closing session...');
  await mtp.closeSession();

  await transport.close();
  console.log('Done!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
