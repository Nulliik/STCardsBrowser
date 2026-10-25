import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('release version is consistent in the manifest, UI and README', async () => {
    const manifest = JSON.parse(await read('manifest.json'));
    assert.equal(manifest.display_name, 'STCardsBrowser');
    const index = await read('src/index.js');
    const templates = await read('src/ui/templates/templates.js');
    assert.equal(index.match(/const EXTENSION_VERSION = '([^']+)'/)[1], manifest.version);
    assert.equal(templates.match(/extensionVersion = '([^']+)'/)[1], manifest.version);
    assert.ok((await read('README.md')).includes(`## What's new in ${manifest.version}`));
    await access(new URL(`../${manifest.js}`, import.meta.url));
    await access(new URL(`../${manifest.css}`, import.meta.url));
});

test('README screenshots exist and the license remains WTFPL+', async () => {
    const readme = await read('README.md');
    const paths = [...readme.matchAll(/src="(assets\/images\/readme\/[^\"]+)"/g)].map(match => match[1]);
    assert.ok(paths.length >= 4);
    for (const path of paths) await access(new URL(`../${path}`, import.meta.url));
    assert.ok((await read('LICENSE')).includes('WTFPL+'));
    assert.ok(readme.includes('[WTFPL+](LICENSE)'));
});

test('every tracked JavaScript module passes the Node syntax check', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'src/**/*.js', 'src/*.js'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.ok(files.length > 0);
    for (const file of files) {
        // Syntax-check the working tree, not the previous committed version.
        const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {
            input: readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
            encoding: 'utf8',
        });
        assert.equal(check.status, 0, `${file}: ${check.stderr || check.error || ''}`);
    }
});
