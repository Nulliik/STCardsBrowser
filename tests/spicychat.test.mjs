import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Exercise the actual adapter without depending on a SillyTavern server or live API.
const source = (await readFile(new URL('../src/services/apis/spicychatApi.js', import.meta.url), 'utf8'))
    .replace("import { proxiedFetch } from '../corsProxy.js';", 'const proxiedFetch = (...args) => globalThis.spicychatTestFetch(...args);')
    .replace("import { secureRandomToken } from '../../utils/utils.js';", "const secureRandomToken = () => 'test-guest';");
let moduleId = 0;
const freshAdapter = () => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${moduleId++}`);
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('concurrent searches discover one configuration and keep pagination and filters', async () => {
    let configRequests = 0;
    const requests = [];
    globalThis.spicychatTestFetch = async (url, options) => {
        assert.equal(options.fetchOptions.headers['Cache-Control'], 'no-transform');
        if (url.endsWith('/applications/spicychat')) {
            configRequests++;
            return response({ typesenseConfig: { apiKeyPublicCharacter: 'public-test-key', collectionNamePublicCharacter: 'public-test' } });
        }
        requests.push(new URL(url));
        assert.equal(options.fetchOptions.headers['X-TYPESENSE-API-KEY'], 'public-test-key');
        return response({ hits: [{ document: { id: 'one' } }], found: 30 });
    };
    const api = await freshAdapter();
    const [first, second] = await Promise.all([
        api.searchSpicychat({ search: ' assistant ', page: 1, perPage: 24, publicOnly: true, filterNsfw: true, nsfwMode: 'nsfw', tags: ['a`b'], excludeTags: ['hidden'], creator: 'creator' }),
        api.searchSpicychat({ page: 2, perPage: 24 }),
    ]);
    assert.equal(configRequests, 1);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    const params = requests[0].searchParams;
    assert.equal(params.get('q'), 'assistant');
    assert.equal(params.get('page'), '1');
    assert.equal(params.get('per_page'), '24');
    assert.ok(params.get('filter_by').includes('application_ids:=spicychat'));
    assert.ok(params.get('filter_by').includes('definition_visible:true'));
    assert.ok(params.get('filter_by').includes('is_nsfw:false'));
    assert.ok(!params.get('filter_by').includes('is_nsfw:true'));
    assert.ok(params.get('filter_by').includes('avatar_is_nsfw:false'));
    assert.ok(params.get('filter_by').includes('tags:=`a\\`b`'));
    assert.ok(params.get('filter_by').includes('creator_username:=`creator`'));
    assert.ok(requests[0].pathname.includes('/collections/public-test/'));
});

test('failed configuration discovery can be retried', async () => {
    const api = await freshAdapter();
    let attempt = 0;
    globalThis.spicychatTestFetch = async url => {
        if (url.endsWith('/applications/spicychat')) {
            if (++attempt === 1) throw new Error('network unavailable');
            return response({ typesenseSearchKey: 'recovered' });
        }
        return response({ hits: [], found: 0 });
    };
    await assert.rejects(api.searchSpicychat(), /network unavailable/);
    assert.deepEqual((await api.searchSpicychat()).characters, []);
    assert.equal(attempt, 2);
});

test('preview hydration preserves the real definition and greeting for direct imports', async () => {
    const api = await freshAdapter();
    let detailRequests = 0;
    globalThis.spicychatTestFetch = async (url, options) => {
        detailRequests++;
        assert.ok(url.endsWith('/v2/characters/public-card'));
        assert.ok(options.fetchOptions.headers['X-Guest-UserId']);
        return response({ id: 'public-card', name: 'Assistant', creator_username: 'author', definition_visible: true, persona: 'Real persona', scenario: 'Real scenario', greeting: 'Real greeting', dialogue: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }], avatar_url: 'test.png', tags: ['SFW'] });
    };
    const card = await api.hydrateSpicychatCard(api.transformSpicychatCard({ character_id: 'public-card', title: 'Public preview', avatar_url: 'test.png' }));
    assert.equal(card.description, 'Real persona');
    assert.equal(card.first_mes, 'Real greeting');
    assert.equal(card.scenario, 'Real scenario');
    assert.equal(card.creator, 'author');
    assert.equal(card.definitionVisible, true);
    assert.match(card.mes_example, /\{\{char\}\}: Hello/);
    assert.equal((await api.hydrateSpicychatCard(card)), card);
    assert.equal(detailRequests, 1);
});

test('hidden definitions and missing greetings are not fabricated', async () => {
    const api = await freshAdapter();
    const hidden = api.transformFullSpicychatCharacter({ name: 'Hidden', title: 'Public preview', definition_visible: false, greeting: 'Public greeting' });
    assert.equal(hidden.description, '');
    assert.equal(hidden.first_mes, 'Public greeting');
    assert.equal(hidden.definitionVisible, false);
    assert.match(hidden.creator_notes, /creator-hidden/);
    const empty = api.transformFullSpicychatCharacter({ name: 'Empty', definition_visible: true });
    assert.equal(empty.first_mes, '');
    globalThis.spicychatTestFetch = async () => { throw new Error('detail unavailable'); };
    await assert.rejects(api.hydrateSpicychatCard({ id: 'unavailable' }), /detail unavailable/);
});
