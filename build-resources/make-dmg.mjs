#!/usr/bin/env node
// Rebuild DMGs with appdmg for proper background support (works around electron-builder DS_Store bug)
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const configTemplate = path.join(__dirname, 'dmg-config.json');

const targets = [
    { arch: 'arm64', appDir: 'mac-arm64', dmgName: `Zune Explorer-${version}-arm64.dmg` },
    { arch: 'x64',   appDir: 'mac',       dmgName: `Zune Explorer-${version}.dmg` },
];

for (const target of targets) {
    const appPath = path.join(root, 'dist', target.appDir, 'Zune Explorer.app');
    const dmgOut = path.join(root, 'dist', target.dmgName);

    if (!existsSync(appPath)) {
        console.log(`Skipping ${target.arch} — app not found at ${appPath}`);
        continue;
    }

    // Patch the config with the actual app path
    const config = JSON.parse(readFileSync(configTemplate, 'utf8'));
    config.contents[0].path = appPath;

    const tmpConfig = path.join(__dirname, `dmg-config-tmp-${target.arch}.json`);
    writeFileSync(tmpConfig, JSON.stringify(config, null, 2));

    // Remove existing DMG
    if (existsSync(dmgOut)) {
        unlinkSync(dmgOut);
        console.log(`Removed old ${target.arch} DMG`);
    }

    console.log(`Building ${target.arch} DMG with appdmg...`);
    try {
        execFileSync('npx', ['appdmg', tmpConfig, dmgOut], {
            cwd: __dirname,
            stdio: 'inherit',
        });
        console.log(`DMG created: ${dmgOut}\n`);
    } finally {
        if (existsSync(tmpConfig)) unlinkSync(tmpConfig);
    }
}
