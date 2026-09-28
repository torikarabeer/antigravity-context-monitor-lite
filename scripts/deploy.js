const fs = require('fs');
const path = require('path');
const os = require('os');

const homeDir = os.homedir();
const targets = [
    path.join(homeDir, '.antigravity-ide', 'extensions', 'personal.antigravity-context-monitor-lite-0.1.0'),
    path.join(homeDir, '.vscode', 'extensions', 'personal.antigravity-context-monitor-lite-0.1.0')
];

const root = path.resolve(__dirname, '..');

for (const target of targets) {
    const parent = path.dirname(target);
    if (!fs.existsSync(parent)) {
        continue;
    }
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'));
    if (fs.existsSync(path.join(root, 'README.md'))) {
        fs.copyFileSync(path.join(root, 'README.md'), path.join(target, 'README.md'));
    }
    fs.cpSync(path.join(root, 'out'), path.join(target, 'out'), { recursive: true, force: true });
    console.log(`[Deploy] Synced to ${target}`);
}
console.log('[Deploy] Done!');
