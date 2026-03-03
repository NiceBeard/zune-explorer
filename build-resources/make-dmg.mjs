#!/usr/bin/env node
// Rebuild DMG with appdmg for proper background support (works around electron-builder DS_Store bug)
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const appDir = path.join(root, 'dist', 'mac-arm64', 'Zune Explorer.app');
const dmgOut = path.join(root, 'dist', 'Zune Explorer-1.0.0-arm64.dmg');
const configTemplate = path.join(__dirname, 'dmg-config.json');

if (!existsSync(appDir)) {
    console.error(`App not found at ${appDir}`);
    console.error('Run "npm run build" first.');
    process.exit(1);
}

// Patch the config with the actual app path
const config = JSON.parse(readFileSync(configTemplate, 'utf8'));
config.contents[0].path = appDir;

const tmpConfig = path.join(__dirname, 'dmg-config-tmp.json');
writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

// Remove existing DMG
if (existsSync(dmgOut)) {
    unlinkSync(dmgOut);
    console.log('Removed old DMG');
}

console.log('Building DMG with appdmg...');
try {
    execFileSync('npx', ['appdmg', tmpConfig, dmgOut], {
        cwd: __dirname,
        stdio: 'inherit',
    });
    console.log(`\nDMG created: ${dmgOut}`);
} finally {
    unlinkSync(tmpConfig);
}
