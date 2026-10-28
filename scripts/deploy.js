const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const extFolderName = `${pkg.publisher || 'personal'}.${pkg.name}-${pkg.version}`;

const homeDir = os.homedir();
const extensionRoots = [
    path.join(homeDir, '.antigravity-ide', 'extensions'),
    path.join(homeDir, '.vscode', 'extensions')
];

for (const extRoot of extensionRoots) {
    if (!fs.existsSync(extRoot)) {
        continue;
    }

    // Clean up older versions of this extension if present
    const prefix = `${pkg.publisher || 'personal'}.${pkg.name}-`;
    try {
        const entries = fs.readdirSync(extRoot);
        for (const entry of entries) {
            if (entry.startsWith(prefix) && entry !== extFolderName) {
                const oldPath = path.join(extRoot, entry);
                fs.rmSync(oldPath, { recursive: true, force: true });
                console.log(`[Deploy] Removed older version: ${oldPath}`);
            }
        }
    } catch {
        // Non-fatal if cleanup fails
    }

    const target = path.join(extRoot, extFolderName);
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(target, 'package.json'));
    if (fs.existsSync(path.join(root, 'README.md'))) {
        fs.copyFileSync(path.join(root, 'README.md'), path.join(target, 'README.md'));
    }
    fs.cpSync(path.join(root, 'out'), path.join(target, 'out'), { recursive: true, force: true });
    console.log(`[Deploy] Synced to ${target}`);
}
console.log('[Deploy] Done!');
