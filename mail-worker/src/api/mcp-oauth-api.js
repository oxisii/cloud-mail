import app from '../hono/hono';
import mcpOauthService from '../service/mcp-oauth-service';

const NO_STORE = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };
const PAGE_HEADERS = {
	'Cache-Control': 'no-store',
	'X-Frame-Options': 'DENY',
	'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};

function originOf(c) {
	return new URL(c.req.url).origin;
}

function queryParams(c) {
	const params = {};
	const url = new URL(c.req.url);
	for (const [key, value] of url.searchParams.entries()) {
		if (params[key] === undefined) {
			params[key] = value;
		}
	}
	return params;
}

function fieldsFrom(raw) {
	const params = {};
	for (const [key, value] of Object.entries(raw || {})) {
		if (typeof value === 'string') {
			params[key] = value;
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			params[key] = String(value);
		} else if (Array.isArray(value) && typeof value[0] === 'string') {
			params[key] = value[0];
		}
	}
	return params;
}

async function readParams(c) {
	const type = (c.req.header('content-type') || '').toLowerCase();
	if (type.includes('application/json')) {
		const raw = await c.req.json();
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return null;
		}
		return fieldsFrom(raw);
	}
	return fieldsFrom(await c.req.parseBody());
}

function sendOauth(c, result) {
	return c.json(result.body, result.status, result.headers || NO_STORE);
}

function sendPage(c, result) {
	if (result.location) {
		c.header('Cache-Control', 'no-store');
		c.header('Referrer-Policy', 'no-referrer');
		return c.redirect(result.location, result.status || 302);
	}
	if (result.html != null) {
		return c.html(result.html, result.status || 200, PAGE_HEADERS);
	}
	return c.text(result.text || 'Bad Request', result.status || 400, NO_STORE);
}

app.get('/.well-known/oauth-protected-resource', (c) => {
	return c.json(mcpOauthService.protectedResourceMetadata(originOf(c)));
});

app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
	return c.json(mcpOauthService.protectedResourceMetadata(originOf(c)));
});

app.get('/.well-known/oauth-authorization-server', (c) => {
	return c.json(mcpOauthService.authorizationServerMetadata(originOf(c)));
});

app.post('/oauth/register', async (c) => {
	const type = (c.req.header('content-type') || '').toLowerCase();
	if (!type.includes('application/json')) {
		return c.json({ error: 'invalid_client_metadata', error_description: 'Content-Type must be application/json' }, 400, NO_STORE);
	}
	let metadata;
	try {
		metadata = await c.req.json();
	} catch {
		return c.json({ error: 'invalid_client_metadata', error_description: 'Request body is not valid JSON' }, 400, NO_STORE);
	}
	try {
		return sendOauth(c, await mcpOauthService.registerClient(c, metadata));
	} catch (error) {
		console.error(error);
		return c.json({ error: 'server_error', error_description: 'Internal error' }, 500, NO_STORE);
	}
});

app.get('/oauth/authorize', async (c) => {
	try {
		return sendPage(c, await mcpOauthService.authorizeGet(c, queryParams(c)));
	} catch (error) {
		console.error(error);
		return c.text('Internal error', 500, NO_STORE);
	}
});

app.post('/oauth/authorize', async (c) => {
	try {
		const params = await readParams(c);
		if (!params) {
			return c.text('OAuth 授权参数无效 / Invalid authorization request: body is not valid', 400, NO_STORE);
		}
		return sendPage(c, await mcpOauthService.authorizePost(c, params));
	} catch (error) {
		console.error(error);
		return c.text('Internal error', 500, NO_STORE);
	}
});

app.post('/oauth/token', async (c) => {
	let params;
	try {
		params = await readParams(c);
	} catch {
		return c.json({ error: 'invalid_request', error_description: 'Request body is not valid' }, 400, NO_STORE);
	}
	if (!params) {
		return c.json({ error: 'invalid_request', error_description: 'Request body is not valid' }, 400, NO_STORE);
	}
	try {
		const basic = mcpOauthService.parseBasicAuth(c.req.header('Authorization'));
		return sendOauth(c, await mcpOauthService.exchangeToken(c, params, basic));
	} catch (error) {
		console.error(error);
		return c.json({ error: 'server_error', error_description: 'Internal error' }, 500, NO_STORE);
	}
});

app.post('/oauth/revoke', async (c) => {
	try {
		const params = await readParams(c);
		await mcpOauthService.revokeToken(c, params || {});
		return c.body(null, 200);
	} catch (error) {
		console.error(error);
		return c.body(null, 200);
	}
});
