import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Mock only SillyTavern settings and transport; execute the actual adapter.
const source = (await readFile(new URL('../src/services/apis/quillgenApi.js', import.meta.url), 'utf8'))
    .replace("import { extension_settings } from '/scripts/extensions.js';", 'const extension_settings = globalThis.quillgenTestSettings;')
    .replace("import { proxiedFetch } from '../corsProxy.js';", 'const proxiedFetch = (...args) => globalThis.quillgenTestFetch(...args);');
let moduleId = 0;
const secret = 'fake-account-secret-for-tests';
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
async function adapter(key = secret) {
    globalThis.quillgenTestSettings = { CleanBotBrowser: { quillgenApiKey: key } };
    globalThis.toastr = { error() {}, info() {} };
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleId++}`);
}

test('index uses Bearer authentication without embedding keys in card URLs', async () => {
    const api = await adapter();
    globalThis.quillgenTestFetch = async (url, options) => {
        assert.equal(new URL(url).origin, 'https://quillgen.app');
        assert.ok(!url.includes(secret));
        assert.equal(options.fetchOptions.headers.Authorization, `Bearer ${secret}`);
        return response({ cards: [
            { id: 'assistant', name: 'Assistant', is_own: true, image_url: 'https://quillgen.app/card.png?download=1' },
            { avatar_url: `https://quillgen.app/avatar.png?KEY=${secret}&size=300`, image_url: `https://quillgen.app/old.png?key=${secret}&download=1` },
        ] });
    };
    const cards = await api.loadQuillgenIndex();
    assert.equal(cards.length, 2);
    assert.equal(cards[0].is_own, true);
    assert.equal(cards[0].avatar_url, 'https://quillgen.app/v1/public/api/browse/characters/assistant/avatar?size=300&format=webp');
    assert.equal(cards[0].image_url, 'https://quillgen.app/card.png?download=1');
    assert.equal(cards[1].avatar_url, 'https://quillgen.app/avatar.png?size=300');
    assert.equal(cards[1].image_url, 'https://quillgen.app/old.png?download=1');
    assert.ok(!JSON.stringify(cards).includes(secret));
});

test('cached URL keys are removed and same-origin import retains Bearer authentication', async () => {
    const api = await adapter();
    globalThis.quillgenTestFetch = async (url, options) => {
        assert.equal(url, 'https://quillgen.app/card.png?download=1');
        assert.equal(options.fetchOptions.headers.Authorization, `Bearer ${secret}`);
        return new Response('card-bytes', { headers: { 'Content-Type': 'image/png' } });
    };
    const blob = await api.fetchQuillgenCard({ image_url: `https://quillgen.app/card.png?key=${secret}&download=1` });
    assert.equal(await blob.text(), 'card-bytes');
});

test('external and lookalike download origins never receive the account key', async () => {
    const api = await adapter();
    let calls = 0;
    globalThis.quillgenTestFetch = async (url, options) => {
        calls++;
        assert.ok(!url.includes(secret));
        assert.equal(options.fetchOptions.headers?.Authorization, undefined);
        return new Response('public-card');
    };
    for (const origin of ['https://cdn.example', 'https://quillgen.app.example', 'http://quillgen.app', 'https://quillgen.app:8443']) {
        assert.ok(await api.fetchQuillgenCard({ image_url: `${origin}/card.png?api_key=${secret}` }));
    }
    assert.equal(calls, 4);
});

test('anonymous public browsing and import still work without a configured key', async () => {
    const api = await adapter('');
    globalThis.quillgenTestFetch = async (url, options) => {
        assert.equal(options.fetchOptions.headers?.Authorization, undefined);
        return url.includes('/characters?')
            ? response({ cards: [{ id: 'public', image_url: 'https://quillgen.app/public.png' }] })
            : new Response('public-card');
    };
    const [card] = await api.loadQuillgenIndex();
    assert.equal(await (await api.fetchQuillgenCard(card)).text(), 'public-card');
});

test('invalid download URLs fail without a network request', async () => {
    const api = await adapter();
    globalThis.quillgenTestFetch = async () => assert.fail('invalid URL must not be fetched');
    for (const image_url of ['', undefined, 'javascript:alert(1)', 'https://user:secret@quillgen.app/card.png']) {
        assert.equal(await api.fetchQuillgenCard({ image_url }), null);
    }
});
