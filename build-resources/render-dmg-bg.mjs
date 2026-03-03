import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'dmg-background.html');
const fileUrl = `file://${htmlPath}`;

const browser = await chromium.launch();

// 1x render (660x400)
const page1x = await browser.newPage({ viewport: { width: 660, height: 400 }, deviceScaleFactor: 1 });
await page1x.goto(fileUrl);
await page1x.screenshot({ path: path.join(__dirname, 'dmg-background.png'), fullPage: false });
console.log('Rendered dmg-background.png (660x400)');

// 2x Retina render (660x400 viewport at 2x scale → 1320x800 image)
const page2x = await browser.newPage({ viewport: { width: 660, height: 400 }, deviceScaleFactor: 2 });
await page2x.goto(fileUrl);
await page2x.screenshot({ path: path.join(__dirname, 'dmg-background@2x.png'), fullPage: false });
console.log('Rendered dmg-background@2x.png (1320x800 Retina)');

await browser.close();
