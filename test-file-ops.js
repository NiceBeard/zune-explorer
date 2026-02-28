// Test file operations without MTPZ authentication
const { UsbTransport, ZUNE_VENDOR_ID } = require('./src/main/zune/usb-transport');
const { MtpProtocol } = require('./src/main/zune/mtp-protocol');

async function main() {
  const transport = new UsbTransport();
  const found = await transport.findZune();
  if (!found) { console.log('No Zune found.'); process.exit(1); }

  console.log(`Found: ${found.model}`);
  await transport.open(ZUNE_VENDOR_ID, found.productId);
  const mtp = new MtpProtocol(transport);

  await mtp.openSession(1);
  console.log('Session opened (no MTPZ auth).\n');

  const storageIds = await mtp.getStorageIDs();
  const storageId = storageIds[0];
  const storageInfo = await mtp.getStorageInfo(storageId);
  console.log(`Storage: ${storageInfo.storageDescription}`);
  console.log(`  Capacity: ${(storageInfo.maxCapacity / 1e9).toFixed(1)} GB`);
  console.log(`  Free: ${(storageInfo.freeSpace / 1e9).toFixed(1)} GB`);

  // List root directories
  console.log('\n=== Root directories ===');
  const rootHandles = await mtp.getObjectHandles(storageId, 0, 0xFFFFFFFF);

  for (const h of rootHandles) {
    const info = await mtp.getObjectInfo(h);
    const type = info.objectFormat === 0x3001 ? '[DIR]' : '[FILE]';
    console.log(`${type} "${info.filename}" (handle=0x${h.toString(16)}, format=0x${info.objectFormat.toString(16)})`);

    // List children of each directory
    if (info.objectFormat === 0x3001) {
      try {
        const children = await mtp.getObjectHandles(storageId, 0, h);
        if (children.length > 0) {
          for (const ch of children.slice(0, 5)) {
            const childInfo = await mtp.getObjectInfo(ch);
            const childType = childInfo.objectFormat === 0x3001 ? '[DIR]' : '[FILE]';
            console.log(`  ${childType} "${childInfo.filename}" (size=${childInfo.compressedSize})`);
          }
          if (children.length > 5) console.log(`  ... and ${children.length - 5} more`);
        }
      } catch (err) {
        console.log(`  (error listing children: ${err.message})`);
      }
    }
  }

  // Try sending a tiny test file
  console.log('\n=== Testing file send (without MTPZ) ===');
  try {
    const testData = Buffer.from('Hello from ZuneExplorer!');
    const result = await mtp.sendObjectInfo(storageId, 0, {
      objectFormat: 0x3000, // Undefined format
      compressedSize: testData.length,
      filename: 'test-zune-explorer.txt',
    });
    console.log('sendObjectInfo OK:', result);

    await mtp.sendObject(testData);
    console.log('sendObject OK! File sent successfully without MTPZ!');
  } catch (err) {
    console.log('File send failed:', err.message);
    console.log('(MTPZ may be required for file transfers)');
  }

  await mtp.closeSession();
  await transport.close();
  console.log('\nDone!');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
