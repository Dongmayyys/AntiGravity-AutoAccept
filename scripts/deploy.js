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
 * Reads extensions.json to find the active install directory,
 * so it works regardless of marketplace version updates.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// ====================== Config ======================

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const EXTENSIONS_DIR = path.join(os.homedir(), '.antigravity', 'extensions');
const EXTENSIONS_JSON = path.join(EXTENSIONS_DIR, 'extensions.json');

/**
 * Auto-detect the active install directory from extensions.json.
 * Falls back to scanning the extensions folder if registry not found.
 */
function resolveInstallDir() {
    // Strategy 1: Read extensions.json registry (source of truth)
    if (fs.existsSync(EXTENSIONS_JSON)) {
        try {
            const registry = JSON.parse(fs.readFileSync(EXTENSIONS_JSON, 'utf8'));
            const entry = registry.find(e =>
                e.identifier?.id === 'yazanbaker.antigravity-autoaccept'
            );
            if (entry?.relativeLocation) {
                console.log(`  📍 Found in extensions.json: ${entry.relativeLocation}`);
                return entry.relativeLocation;
            }
        } catch (e) {
            console.warn(`  ⚠ Failed to parse extensions.json: ${e.message}`);
        }
    }

    // Strategy 2: Find newest matching directory
    if (fs.existsSync(EXTENSIONS_DIR)) {
        const dirs = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('yazanbaker.antigravity-autoaccept-'))
            .map(d => ({ name: d.name, mtime: fs.statSync(path.join(EXTENSIONS_DIR, d.name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
        if (dirs.length > 0) {
            console.log(`  📍 Fallback: newest directory: ${dirs[0].name}`);
            return dirs[0].name;
        }
    }

    // Strategy 3: Default
    const fallback = `yazanbaker.antigravity-autoaccept-${pkg.version}`;
    console.log(`  📍 Fallback: using version from package.json: ${fallback}`);
    return fallback;
}

const INSTALL_DIR_NAME = resolveInstallDir();
const DEST = path.join(EXTENSIONS_DIR, INSTALL_DIR_NAME);

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
