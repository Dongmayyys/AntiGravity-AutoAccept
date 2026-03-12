/**
 * Deploy extension to local Antigravity installation.
 *
 * Usage: npm run deploy
 *
 * Steps:
 *   1. Copy src/, images/, package.json to install directory
 *   2. Install production dependencies (ws)
 *   3. Verify deployed artifact
 *
 * Note: AutoAccept is pure JS — no build step needed.
 * The install directory name stays fixed (3.4.0) to avoid
 * editing Antigravity's extensions.json registry.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ====================== Config ======================

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// Fixed directory name — changing it requires editing extensions.json
const INSTALL_DIR_NAME = 'yazanbaker.antigravity-autoaccept-3.4.0';
const DEST = path.join(os.homedir(), '.antigravity', 'extensions', INSTALL_DIR_NAME);

const COPY_DIRS = ['src', 'images'];
const COPY_FILES = ['package.json'];

// ====================== Helpers ======================

function log(msg) {
    console.log(`  ${msg}`);
}

function step(label) {
    console.log(`\n▸ ${label}`);
}

function rmSafe(target) {
    if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
        return true;
    }
    return false;
}

// ====================== Main ======================

console.log(`\n🚀 Deploying ${pkg.name}@${pkg.version}`);
console.log(`   Target: ${DEST}\n`);

// Verify source
if (!fs.existsSync(path.join(ROOT, 'src', 'extension.js'))) {
    console.error('❌ src/extension.js not found. Are you in the right directory?');
    process.exit(1);
}

// Step 1: Ensure target directory exists
step('Prepare install directory');
if (!fs.existsSync(DEST)) {
    fs.mkdirSync(DEST, { recursive: true });
    log(`Created: ${DEST}`);
} else {
    log(`Exists: ${DEST}`);
}

// Step 2: Copy directories (remove old → copy fresh)
step('Copy files');
for (const dir of COPY_DIRS) {
    const src = path.join(ROOT, dir);
    const dst = path.join(DEST, dir);
    if (!fs.existsSync(src)) {
        log(`⚠ Skipped ${dir}/ (not found)`);
        continue;
    }
    rmSafe(dst);
    fs.cpSync(src, dst, { recursive: true });
    // Count files
    const count = countFiles(dst);
    log(`${dir}/ (${count} files)`);
}
for (const file of COPY_FILES) {
    const src = path.join(ROOT, file);
    const dst = path.join(DEST, file);
    if (!fs.existsSync(src)) {
        log(`⚠ Skipped ${file} (not found)`);
        continue;
    }
    fs.copyFileSync(src, dst);
    log(file);
}

// Step 3: Install production dependencies
step('Install dependencies');
try {
    execSync('npm install --omit=dev', { cwd: DEST, stdio: 'inherit' });
} catch {
    console.error('\n❌ npm install failed.');
    process.exit(1);
}

// Step 4: Verify
step('Verify deployment');
const checks = [
    path.join(DEST, 'src', 'extension.js'),
    path.join(DEST, 'src', 'cdp', 'ConnectionManager.js'),
    path.join(DEST, 'src', 'cdp', 'cdp-worker.js'),
    path.join(DEST, 'src', 'scripts', 'DOMObserver.js'),
    path.join(DEST, 'package.json'),
    path.join(DEST, 'node_modules', 'ws'),
];
let allOk = true;
for (const f of checks) {
    const exists = fs.existsSync(f);
    const label = path.relative(DEST, f);
    if (exists) {
        log(`${label} ✓`);
    } else {
        log(`${label} ✗ MISSING`);
        allOk = false;
    }
}

if (!allOk) {
    console.error('\n❌ Verification failed: some files are missing.');
    process.exit(1);
}

console.log(`\n✅ Deployed successfully! (${pkg.version} → ${INSTALL_DIR_NAME})`);
console.log(`   Close ALL Antigravity windows and restart to apply.\n`);

// ====================== Utilities ======================

function countFiles(dir) {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            count += countFiles(path.join(dir, entry.name));
        } else {
            count++;
        }
    }
    return count;
}
