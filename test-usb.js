const { ZuneManager } = require('./src/main/zune/zune-manager');

async function main() {
  const zm = new ZuneManager();

  zm.on('status', (status) => {
    console.log('STATUS:', JSON.stringify(status));
  });

  zm.on('transfer-progress', (progress) => {
    console.log('PROGRESS:', JSON.stringify(progress));
  });

  console.log('Starting ZuneManager...');
  await zm.start();

  // Give it time to connect
  await new Promise(resolve => setTimeout(resolve, 10000));

  console.log('Device info:', JSON.stringify(zm.getDeviceInfo()));

  zm.stop();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
