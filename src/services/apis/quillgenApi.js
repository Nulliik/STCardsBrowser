import { extension_settings } from '/scripts/extensions.js';
import { proxiedFetch } from '../corsProxy.js';

const QUILLGEN_API_URL = 'https://quillgen.app/v1/public/api/browse';

// Also clean URLs produced by older versions and retained in cached cards.
function cleanCardUrl(value) {
    if (!value) return value;
    try {
        const url = new URL(value, `${QUILLGEN_API_URL}/`);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
        for (const name of [...url.searchParams.keys()]) {
            if (/^(key|api_key|apikey)$/i.test(name)) url.searchParams.delete(name);
        }
        return url.href;
    } catch {
        return '';
    }
}

/**
 * Load characters from QuillGen API.
 * Without API key: returns public characters only.
 * With API key: returns public characters + user's own characters (marked with is_own).
 * @returns {Promise<Array>} Array of QuillGen cards in CleanBotBrowser format
 */
export async function loadQuillgenIndex() {
    const settings = extension_settings?.['CleanBotBrowser'] || {};
    const apiKey = settings.quillgenApiKey;

    try {
        const headers = { 'Accept': 'application/json' };
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await proxiedFetch(`${QUILLGEN_API_URL}/characters?limit=500`, {
            service: 'quillgen',
            fetchOptions: { headers },
        });

        if (response.status === 401) {
            if (apiKey) {
                console.error('[CleanBotBrowser] QuillGen API key is invalid');
                toastr.error('QuillGen API key is invalid. Check your settings.', 'Authentication Failed');
            } else {
                console.warn('[CleanBotBrowser] QuillGen requires authentication for this request');
            }
            return [];
        }

        if (!response.ok) {
            console.error(`[CleanBotBrowser] QuillGen API error: ${response.status}`);
            toastr.error(`Failed to load QuillGen characters: ${response.statusText}`);
            return [];
        }

        const data = await response.json();
        const cards = data.cards || [];

        const mappedCards = cards.map(card => transformQuillgenCard(card));

        const ownCount = mappedCards.filter(c => c.is_own).length;
        const publicCount = mappedCards.length - ownCount;
        console.log(`[CleanBotBrowser] Loaded ${mappedCards.length} cards from QuillGen (${publicCount} public, ${ownCount} own)`);

        if (mappedCards.length === 0) {
            const msg = apiKey
                ? 'No characters found. Create some on QuillGen.app!'
                : 'No public characters available yet.';
            toastr.info(msg, 'QuillGen');
        }

        return mappedCards;
    } catch (error) {
        console.error('[CleanBotBrowser] Error loading QuillGen index:', error);
        toastr.error('Failed to connect to QuillGen');
        return [];
    }
}

/**
 * Fetch a QuillGen card PNG blob for import.
 * @param {Object} card - Card object with image_url
 * @returns {Promise<Blob>} The card image blob
 */
export async function fetchQuillgenCard(card) {
    const settings = extension_settings?.['CleanBotBrowser'] || {};
    const apiKey = settings.quillgenApiKey;

    const cardUrl = cleanCardUrl(card.image_url);
    if (!cardUrl) {
        toastr.error('QuillGen card has no valid download URL');
        return null;
    }
    // Log the URL without the key for security
    const logUrl = cardUrl.split('?')[0];
    console.log('[CleanBotBrowser] Fetching QuillGen card from:', logUrl);

    const fetchOptions = {};
    // Never send the account key to a CDN or another origin supplied by a card.
    if (apiKey && apiKey.trim() !== '' && new URL(cardUrl).origin === new URL(QUILLGEN_API_URL).origin) {
        fetchOptions.headers = { 'Authorization': `Bearer ${apiKey}` };
    }

    try {
        const response = await proxiedFetch(cardUrl, {
            service: 'quillgen',
            fetchOptions,
        });

        if (response.status === 401) {
            console.error('[CleanBotBrowser] QuillGen authentication failed', response);
            toastr.error('QuillGen API key is invalid. Check your settings.', 'Invalid API key');
            return null;
        }

        if (!response.ok) {
            console.error(`[CleanBotBrowser] Failed to fetch QuillGen card: ${response.status}`, response);
            toastr.error(`Failed to fetch QuillGen card: ${response.statusText}`);
            return null;
        }

        console.log('[CleanBotBrowser] ✓ Successfully fetched QuillGen card');
        return await response.blob();
    } catch (err) {
        console.error('[CleanBotBrowser] Error fetching QuillGen card:', err);
        toastr.error('Failed to fetch QuillGen card');
        return null;
    }
}

/**
 * Transform a QuillGen card to CleanBotBrowser format
 * @param {Object} card - Raw card from QuillGen API
 * @returns {Object} Card in CleanBotBrowser format
 */
function transformQuillgenCard(card) {
    // Use the optimized avatar endpoint for browsing (bandwidth saving)
    // Default to 300px WebP as per API docs
    let avatarUrl = cleanCardUrl(card.avatar_url);
    if (card.id) {
        avatarUrl = `${QUILLGEN_API_URL}/characters/${encodeURIComponent(card.id)}/avatar?size=300&format=webp`;
    }

    return {
        ...card,
        avatar_url: avatarUrl,
        image_url: cleanCardUrl(card.image_url),
        service: 'quillgen',
        chunk: null // QuillGen cards don't use chunks - they're fetched directly
    };
}
