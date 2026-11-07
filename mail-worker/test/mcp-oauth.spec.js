import { describe, expect, it, vi } from 'vitest';
import app from '../src/hono/webs.js';
import worker from '../src/index.js';
import KvConst from '../src/const/kv-const.js';
import userService from '../src/service/user-service.js';
import cryptoUtils from '../src/utils/crypto-utils.js';
import {
	authorizationServerMetadata,
	authorizeGet,
	authorizeMcp,
	authorizePost,
	codeChallengeS256,
	exchangeToken,
	listDevices,
	protectedResourceMetadata,
	parseBasicAuth,
	registerClient,
	respondMcpAuthFailure,
	revokeDevice,
	revokeToken
} from '../src/service/mcp-oauth-service.js';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'https://example.com/cb';

function createKv() {
	const store = new Map();
	return {
		async get(key, options) {
			const hit = store.get(key);
			if (!hit) {
				return null;
			}
			if (hit.exp && hit.exp <= Date.now()) {
				store.delete(key);
				return null;
			}
			if (options?.type === 'json') {
				return JSON.parse(hit.value);
			}
			return hit.value;
		},
		async put(key, value, options) {
			const ttl = options?.expirationTtl;
			store.set(key, {
				value: String(value),
				exp: ttl ? Date.now() + ttl * 1000 : 0
			});
		},
		async delete(key) {
			store.delete(key);
		},
		async list({ prefix } = {}) {
			const keys = [];
			for (const [name, hit] of store.entries()) {
				if (hit.exp && hit.exp <= Date.now()) {
					store.delete(name);
					continue;
				}
				if (!prefix || name.startsWith(prefix)) {
					keys.push({ name });
				}
			}
			return { keys, list_complete: true, cursor: '' };
		}
	};
}

function context({
	kv = createKv(),
	url = 'https://mail.example/mcp',
	authorization,
	userAgent,
	ip = '127.0.0.1',
	admin = 'admin@example.com'
} = {}) {
	const headers = { 'cf-connecting-ip': ip };
	if (authorization !== undefined) {
		headers.authorization = authorization;
	}
	if (userAgent !== undefined) {
		headers['user-agent'] = userAgent;
	}
	return {
		env: { kv, admin, domain: ['example.com'] },
		req: {
			url,
			header(name) {
				return headers[String(name || '').toLowerCase()];
			}
		},
		json(body, status, responseHeaders) {
			return { body, status, headers: responseHeaders || {} };
		}
	};
}

async function registerPublic(c, redirectUris = [REDIRECT], extra = {}) {
	return registerClient(c, { redirect_uris: redirectUris, ...extra });
}

async function seedCode(kv, { code, clientId, redirectUri = REDIRECT, challenge = CHALLENGE }) {
	await kv.put(KvConst.MCP_OAUTH_CODE + code, JSON.stringify({
		clientId,
		redirectUri,
		codeChallenge: challenge,
		resource: '',
		scope: 'mcp',
		createdAt: Date.now()
	}), { expirationTtl: 600 });
}

describe('oauth metadata', () => {
	it('describes the protected resource and the authorization server', () => {
		expect(protectedResourceMetadata('https://mail.example')).toEqual({
			resource: 'https://mail.example/mcp',
			authorization_servers: ['https://mail.example'],
			bearer_methods_supported: ['header'],
			scopes_supported: ['mcp'],
			resource_name: 'Cloud Mail MCP'
		});
		expect(authorizationServerMetadata('https://mail.example')).toEqual({
			issuer: 'https://mail.example',
			authorization_endpoint: 'https://mail.example/oauth/authorize',
			token_endpoint: 'https://mail.example/oauth/token',
			registration_endpoint: 'https://mail.example/oauth/register',
			revocation_endpoint: 'https://mail.example/oauth/revoke',
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
			scopes_supported: ['mcp']
		});
	});

	it('lets discovery and oauth through the worker entry', async () => {
		let assets = 0;
		const env = {
			assets: {
				fetch() {
					assets += 1;
					return new Response('spa', { headers: { 'content-type': 'text/html' } });
				}
			}
		};
		const resource = await worker.fetch(new Request('https://mail.example/.well-known/oauth-protected-resource'), env, {});
		const registered = await worker.fetch(new Request('https://mail.example/oauth/register', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] })
		}), env, {});
		expect(assets).toBe(0);
		expect(resource.status).toBe(200);
		expect(resource.headers.get('content-type')).toContain('application/json');
		expect((await resource.json()).resource).toBe('https://mail.example/mcp');
		expect(registered.status).toBe(400);
		expect((await registered.json()).error).toBe('invalid_client_metadata');

		const spa = await worker.fetch(new Request('https://mail.example/inbox'), env, {});
		expect(assets).toBe(1);
		expect(await spa.text()).toBe('spa');
	});

	it('serves discovery JSON instead of the frontend', async () => {
		const resource = await app.request('https://mail.example/.well-known/oauth-protected-resource');
		const resourcePath = await app.request('https://mail.example/.well-known/oauth-protected-resource/mcp');
		const server = await app.request('https://mail.example/.well-known/oauth-authorization-server');

		expect(resource.status).toBe(200);
		expect(resource.headers.get('content-type')).toContain('application/json');
		expect(await resource.json()).toEqual(await resourcePath.json());
		expect((await server.json()).code_challenge_methods_supported).toEqual(['S256']);
	});
});

describe('oauth registration', () => {
	it('rejects redirect URIs that are not https or loopback http', async () => {
		const c = context();
		const cases = [
			['http://evil.example/cb'],
			['javascript:alert(1)'],
			['https://example.com/cb#frag'],
			[],
			'https://example.com/cb'
		];
		for (const redirectUris of cases) {
			const result = await registerClient(c, { redirect_uris: redirectUris });
			expect(result.status).toBe(400);
			expect(result.body.error).toBe('invalid_client_metadata');
		}

		const loopback = await registerPublic(c, [
			'https://claude.ai/api/mcp/auth_callback',
			'http://localhost:3000/cb',
			'http://127.0.0.1:6274/cb',
			'http://[::1]/cb'
		]);
		expect(loopback.status).toBe(201);
		expect(loopback.body.client_id).toBeTruthy();
		expect(loopback.body.client_secret).toBeUndefined();
		expect(loopback.body.token_endpoint_auth_method).toBe('none');
		expect(loopback.body.response_types).toEqual(['code']);
	});

	it('returns a client secret once for confidential clients', async () => {
		const c = context();
		const result = await registerClient(c, {
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: 'client_secret_basic',
			client_name: 'Desk'
		});
		expect(result.status).toBe(201);
		expect(result.body.client_secret).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(result.body.client_secret_expires_at).toBe(0);
		expect(result.body.client_name).toBe('Desk');
		const stored = await c.env.kv.get(KvConst.MCP_OAUTH_CLIENT + result.body.client_id);
		expect(stored).toContain('secretHash');
		expect(stored).not.toContain(result.body.client_secret);
	});
});

describe('oauth tokens', () => {
	it('matches the S256 PKCE test vector', async () => {
		expect(await codeChallengeS256(VERIFIER)).toBe(CHALLENGE);
	});

	it('accepts a matching verifier and rejects a wrong one', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const registered = await registerPublic(c);
		const clientId = registered.body.client_id;

		await seedCode(c.env.kv, { code: 'good-code', clientId });
		const ok = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'good-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER
		}, null);
		expect(ok.status).toBe(200);
		expect(ok.headers['Cache-Control']).toBe('no-store');
		expect(ok.body).toEqual(expect.objectContaining({
			token_type: 'Bearer',
			expires_in: 3600,
			scope: 'mcp'
		}));
		expect(ok.body.access_token).toBeTruthy();
		expect(ok.body.refresh_token).toBeTruthy();

		await seedCode(c.env.kv, { code: 'bad-code', clientId });
		const bad = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'bad-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: `${'b'.repeat(43)}`
		}, null);
		expect(bad.status).toBe(400);
		expect(bad.body.error).toBe('invalid_grant');
	});

	it('rejects a second exchange of the same code', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		await seedCode(c.env.kv, { code: 'once', clientId });
		const params = {
			grant_type: 'authorization_code',
			code: 'once',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER
		};
		expect((await exchangeToken(c, params, null)).status).toBe(200);
		const again = await exchangeToken(c, params, null);
		expect(again.status).toBe(400);
		expect(again.body.error).toBe('invalid_grant');
	});

	it('rotates refresh tokens and rejects the old one', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		await seedCode(c.env.kv, { code: 'refresh-code', clientId });
		const first = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'refresh-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER
		}, null);
		const rotated = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: first.body.refresh_token,
			client_id: clientId
		}, null);
		expect(rotated.status).toBe(200);
		expect(rotated.body.refresh_token).not.toBe(first.body.refresh_token);
		const stale = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: first.body.refresh_token,
			client_id: clientId
		}, null);
		expect(stale.status).toBe(400);
		expect(stale.body.error).toBe('invalid_grant');
		const current = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: rotated.body.refresh_token,
			client_id: clientId
		}, null);
		expect(current.status).toBe(200);
	});

	it('requires the client secret and accepts both basic and post authentication', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const registered = await registerClient(c, {
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: 'client_secret_post'
		});
		const clientId = registered.body.client_id;
		const secret = registered.body.client_secret;
		await seedCode(c.env.kv, { code: 'secret-code', clientId });

		const missing = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'secret-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER
		}, null);
		expect(missing.status).toBe(401);
		expect(missing.body.error).toBe('invalid_client');

		const wrong = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'secret-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			client_secret: 'not-the-secret',
			code_verifier: VERIFIER
		}, null);
		expect(wrong.status).toBe(401);

		const posted = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'secret-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			client_secret: secret,
			code_verifier: VERIFIER
		}, null);
		expect(posted.status).toBe(200);

		const basic = parseBasicAuth(`Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`)}`);
		const refreshed = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: posted.body.refresh_token
		}, basic);
		expect(refreshed.status).toBe(200);
	});

	it('rejects a resource that is not this MCP server', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		await seedCode(c.env.kv, { code: 'resource-code', clientId });
		const denied = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'resource-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER,
			resource: 'https://evil.example/mcp'
		}, null);
		expect(denied.status).toBe(400);
		expect(denied.body.error).toBe('invalid_target');
		const stillThere = await c.env.kv.get(KvConst.MCP_OAUTH_CODE + 'resource-code', { type: 'json' });
		expect(stillThere?.clientId).toBe(clientId);
	});

	it('drops access after revoke', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		await seedCode(c.env.kv, { code: 'revoke-code', clientId });
		const issued = await exchangeToken(c, {
			grant_type: 'authorization_code',
			code: 'revoke-code',
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER
		}, null);
		const before = await authorizeMcp(context({
			kv: c.env.kv,
			authorization: `Bearer ${issued.body.access_token}`
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(before.ok).toBe(true);

		const revoked = await revokeToken(c, { token: issued.body.access_token });
		expect(revoked).toEqual({ status: 200, empty: true });
		const after = await authorizeMcp(context({
			kv: c.env.kv,
			authorization: `Bearer ${issued.body.access_token}`
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(after.ok).toBe(false);
		expect(after.status).toBe(401);
	});
});

describe('mcp auth with oauth', () => {
	it('keeps the static token and accepts an oauth access token', async () => {
		const kv = createKv();
		await kv.put(KvConst.MCP_OAUTH_ACCESS + 'oa-token', JSON.stringify({
			clientId: 'client-1',
			createdAt: Date.now()
		}), { expirationTtl: 3600 });

		const staticHit = await authorizeMcp(context({
			kv,
			authorization: 'Bearer static-token'
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(staticHit.ok).toBe(true);

		const rawStatic = await authorizeMcp(context({
			kv,
			authorization: 'static-token'
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(rawStatic.ok).toBe(true);

		const oauthHit = await authorizeMcp(context({
			kv,
			authorization: 'Bearer oa-token'
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(oauthHit.ok).toBe(true);

		const disabled = await authorizeMcp(context({
			kv,
			authorization: 'Bearer oa-token'
		}), { mcpStatus: 1, mcpToken: 'static-token' });
		expect(disabled.status).toBe(403);
	});

	it('puts resource_metadata on 401 and leaves it off 403', () => {
		const c = context({ url: 'https://mail.example/mcp' });
		const denied = respondMcpAuthFailure(c, { status: 401, message: 'MCP token validation failed' });
		expect(denied.status).toBe(401);
		expect(denied.headers['WWW-Authenticate']).toBe(
			'Bearer resource_metadata="https://mail.example/.well-known/oauth-protected-resource"'
		);
		const closed = respondMcpAuthFailure(c, { status: 403, message: 'MCP service is disabled' });
		expect(closed.status).toBe(403);
		expect(closed.headers['WWW-Authenticate']).toBeUndefined();
	});

	it('returns the discovery header from the /mcp route', async () => {
		const kv = createKv();
		await kv.put(KvConst.SETTING, JSON.stringify({
			emailPrefixFilter: '',
			mcpStatus: 0,
			mcpToken: 'static-token'
		}));
		const env = { kv, domain: ['example.com'], admin: 'admin@example.com' };
		const denied = await app.request('https://mail.example/mcp', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}, env);
		expect(denied.status).toBe(401);
		expect(denied.headers.get('WWW-Authenticate')).toBe(
			'Bearer resource_metadata="https://mail.example/.well-known/oauth-protected-resource"'
		);

		await kv.put(KvConst.SETTING, JSON.stringify({
			emailPrefixFilter: '',
			mcpStatus: 1,
			mcpToken: 'static-token'
		}));
		const closed = await app.request('https://mail.example/mcp', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}, env);
		expect(closed.status).toBe(403);
		expect(closed.headers.get('WWW-Authenticate')).toBeNull();
	});
});

describe('oauth authorize page', () => {
	it('renders a login form and does not redirect an unknown redirect_uri', async () => {
		const c = context({ url: 'https://mail.example/oauth/authorize' });
		const registered = await registerClient(c, {
			redirect_uris: [REDIRECT],
			client_name: '<script>alert(1)</script>'
		});
		const page = await authorizeGet(c, {
			response_type: 'code',
			client_id: registered.body.client_id,
			redirect_uri: REDIRECT,
			code_challenge: CHALLENGE,
			code_challenge_method: 'S256',
			state: 'xyz'
		});
		expect(page.status).toBe(200);
		expect(page.html).toContain('授权 / Authorize');
		expect(page.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(page.html).not.toContain('<script>alert(1)</script>');
		expect(page.location).toBeUndefined();

		const denied = await authorizeGet(c, {
			response_type: 'code',
			client_id: registered.body.client_id,
			redirect_uri: 'https://evil.example/cb',
			code_challenge: CHALLENGE,
			code_challenge_method: 'S256'
		});
		expect(denied.status).toBe(400);
		expect(denied.text).toContain('redirect_uri');
		expect(denied.location).toBeUndefined();
	});

	it('stops repeated login failures with 429', async () => {
		const c = context({ url: 'https://mail.example/oauth/authorize', ip: '203.0.113.8' });
		const registered = await registerPublic(c);
		await c.env.kv.put(
			KvConst.MCP_OAUTH_FAIL + 'admin@example.com:203.0.113.8',
			JSON.stringify({ count: 10 }),
			{ expirationTtl: 3600 }
		);
		const limited = await authorizePost(c, {
			response_type: 'code',
			client_id: registered.body.client_id,
			redirect_uri: REDIRECT,
			code_challenge: CHALLENGE,
			code_challenge_method: 'S256',
			email: 'admin@example.com',
			password: 'wrong-password'
		});
		expect(limited.status).toBe(429);
		expect(limited.html).toContain('尝试次数过多');
		expect(limited.location).toBeUndefined();
	});
});

describe('oauth devices', () => {
	async function exchangeSeededCode(c, { code, clientId, deviceId, userAgent }) {
		const record = {
			clientId,
			redirectUri: REDIRECT,
			codeChallenge: CHALLENGE,
			resource: '',
			scope: 'mcp',
			createdAt: Date.now()
		};
		if (deviceId) {
			record.deviceId = deviceId;
			record.userAgent = userAgent || '';
		}
		await c.env.kv.put(KvConst.MCP_OAUTH_CODE + code, JSON.stringify(record), { expirationTtl: 600 });
		return exchangeToken(c, {
			grant_type: 'authorization_code',
			code,
			redirect_uri: REDIRECT,
			client_id: clientId,
			code_verifier: VERIFIER
		}, null);
	}

	it('mints a device on authorize and lists it without token pointers', async () => {
		const c = context({ url: 'https://mail.example/oauth/authorize', userAgent: 'Mozilla/5.0 TestDevice' });
		const registered = await registerClient(c, {
			redirect_uris: [REDIRECT],
			client_name: 'Desk'
		});
		const userSpy = vi.spyOn(userService, 'selectByEmailIncludeDel').mockResolvedValue({
			email: 'admin@example.com',
			isDel: 0,
			status: 0,
			salt: 'salt',
			password: 'hash'
		});
		const pwdSpy = vi.spyOn(cryptoUtils, 'verifyPassword').mockResolvedValue(true);
		try {
			const approved = await authorizePost(c, {
				response_type: 'code',
				client_id: registered.body.client_id,
				redirect_uri: REDIRECT,
				code_challenge: CHALLENGE,
				code_challenge_method: 'S256',
				state: 's',
				email: 'admin@example.com',
				password: 'secret'
			});
			expect(approved.status).toBe(302);
			const code = new URL(approved.location).searchParams.get('code');
			const storedCode = await c.env.kv.get(KvConst.MCP_OAUTH_CODE + code, { type: 'json' });
			expect(storedCode.deviceId).toBeTruthy();
			expect(storedCode.userAgent).toBe('Mozilla/5.0 TestDevice');

			const tokenCtx = context({ url: 'https://mail.example/oauth/token', kv: c.env.kv });
			const issued = await exchangeToken(tokenCtx, {
				grant_type: 'authorization_code',
				code,
				redirect_uri: REDIRECT,
				client_id: registered.body.client_id,
				code_verifier: VERIFIER
			}, null);
			expect(issued.status).toBe(200);
			expect(issued.body.accessToken).toBeUndefined();
			expect(issued.body.refreshToken).toBeUndefined();

			const devices = await listDevices(tokenCtx);
			expect(devices).toHaveLength(1);
			expect(devices[0]).toEqual({
				deviceId: storedCode.deviceId,
				clientId: registered.body.client_id,
				clientName: 'Desk',
				userAgent: 'Mozilla/5.0 TestDevice',
				createdAt: expect.any(Number),
				lastUsedAt: expect.any(Number)
			});
			expect(JSON.stringify(devices)).not.toContain(issued.body.access_token);
			expect(JSON.stringify(devices)).not.toContain(issued.body.refresh_token);
			const storedDevice = await c.env.kv.get(KvConst.MCP_OAUTH_DEVICE + storedCode.deviceId, { type: 'json' });
			expect(storedDevice.accessToken).toBe(issued.body.access_token);
			expect(storedDevice.refreshToken).toBe(issued.body.refresh_token);
		} finally {
			userSpy.mockRestore();
			pwdSpy.mockRestore();
		}
	});

	it('does not backfill a device for a code that has no deviceId', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		const issued = await exchangeSeededCode(c, { code: 'legacy-code', clientId });
		expect(issued.status).toBe(200);
		expect(await listDevices(c)).toEqual([]);
	});

	it('updates lastUsedAt only after the 300 second throttle', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const registered = await registerClient(c, {
			redirect_uris: [REDIRECT],
			client_name: 'Desk'
		});
		const issued = await exchangeSeededCode(c, {
			code: 'touch-code',
			clientId: registered.body.client_id,
			deviceId: 'device-touch',
			userAgent: 'TouchAgent/1'
		});
		const key = KvConst.MCP_OAUTH_DEVICE + 'device-touch';
		const created = await c.env.kv.get(key, { type: 'json' });
		const authContext = () => context({
			kv: c.env.kv,
			authorization: `Bearer ${issued.body.access_token}`
		});
		const setting = { mcpStatus: 0, mcpToken: 'static-token' };

		const recent = await authorizeMcp(authContext(), setting);
		expect(recent.ok).toBe(true);
		expect((await c.env.kv.get(key, { type: 'json' })).lastUsedAt).toBe(created.lastUsedAt);

		const staleAt = Date.now() - 301 * 1000;
		created.lastUsedAt = staleAt;
		await c.env.kv.put(key, JSON.stringify(created));
		const touched = await authorizeMcp(authContext(), setting);
		expect(touched.ok).toBe(true);
		const updated = await c.env.kv.get(key, { type: 'json' });
		expect(updated.lastUsedAt).toBeGreaterThan(staleAt);
		expect(updated.accessToken).toBe(issued.body.access_token);
		expect(updated.refreshToken).toBe(issued.body.refresh_token);
	});

	it('still authorizes when the device touch write fails', async () => {
		const kv = createKv();
		const realGet = kv.get.bind(kv);
		await kv.put(KvConst.MCP_OAUTH_ACCESS + 'oa-touch', JSON.stringify({
			clientId: 'client-1',
			deviceId: 'missing-write',
			createdAt: Date.now()
		}), { expirationTtl: 3600 });
		kv.get = async (key, options) => {
			if (String(key).startsWith(KvConst.MCP_OAUTH_DEVICE)) {
				throw new Error('kv down');
			}
			return realGet(key, options);
		};
		const auth = await authorizeMcp(context({
			kv,
			authorization: 'Bearer oa-touch'
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(auth.ok).toBe(true);
	});

	it('keeps the same deviceId and rotates token pointers on refresh', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerClient(c, {
			redirect_uris: [REDIRECT],
			client_name: 'Desk'
		})).body.client_id;
		const issued = await exchangeSeededCode(c, {
			code: 'rotate-code',
			clientId,
			deviceId: 'device-rotate',
			userAgent: 'RotateAgent/1'
		});
		const rotated = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: issued.body.refresh_token,
			client_id: clientId
		}, null);
		expect(rotated.status).toBe(200);
		expect(rotated.body.refresh_token).not.toBe(issued.body.refresh_token);

		const devices = await listDevices(c);
		expect(devices).toHaveLength(1);
		expect(devices[0].deviceId).toBe('device-rotate');
		expect(devices[0].clientName).toBe('Desk');
		expect(JSON.stringify(devices)).not.toContain(rotated.body.access_token);
		expect(JSON.stringify(devices)).not.toContain(rotated.body.refresh_token);

		const stored = await c.env.kv.get(KvConst.MCP_OAUTH_DEVICE + 'device-rotate', { type: 'json' });
		expect(stored.accessToken).toBe(rotated.body.access_token);
		expect(stored.refreshToken).toBe(rotated.body.refresh_token);
		expect(stored.accessToken).not.toBe(issued.body.access_token);
		const access = await c.env.kv.get(KvConst.MCP_OAUTH_ACCESS + rotated.body.access_token, { type: 'json' });
		expect(access.deviceId).toBe('device-rotate');
	});

	it('rejects the access token and refresh token after revokeDevice', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		const issued = await exchangeSeededCode(c, {
			code: 'revoke-device-code',
			clientId,
			deviceId: 'device-revoke',
			userAgent: 'RevokeAgent/1'
		});
		await revokeDevice(c, 'device-revoke');

		const after = await authorizeMcp(context({
			kv: c.env.kv,
			authorization: `Bearer ${issued.body.access_token}`
		}), { mcpStatus: 0, mcpToken: 'static-token' });
		expect(after.ok).toBe(false);
		expect(after.status).toBe(401);

		const refreshed = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: issued.body.refresh_token,
			client_id: clientId
		}, null);
		expect(refreshed.status).toBe(400);
		expect(refreshed.body.error).toBe('invalid_grant');
		expect(await listDevices(c)).toEqual([]);

		await revokeDevice(c, 'device-revoke');
		await revokeDevice(c, 'missing-device');
		expect(await listDevices(c)).toEqual([]);
	});

	it('creates a device when an old refresh token has no deviceId', async () => {
		const c = context({ url: 'https://mail.example/oauth/token', userAgent: 'LegacyClient/2' });
		const clientId = (await registerClient(c, {
			redirect_uris: [REDIRECT],
			client_name: 'Old'
		})).body.client_id;
		await c.env.kv.put(KvConst.MCP_OAUTH_REFRESH + 'legacy-refresh', JSON.stringify({
			clientId,
			createdAt: Date.now() - 1000
		}), { expirationTtl: 3600 });

		const rotated = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: 'legacy-refresh',
			client_id: clientId
		}, null);
		expect(rotated.status).toBe(200);

		const devices = await listDevices(c);
		expect(devices).toHaveLength(1);
		expect(devices[0].clientName).toBe('Old');
		expect(devices[0].clientId).toBe(clientId);
		expect(devices[0].userAgent).toBe('LegacyClient/2');
		expect(devices[0].deviceId).toBeTruthy();
		expect(JSON.stringify(devices)).not.toContain(rotated.body.access_token);
		expect(JSON.stringify(devices)).not.toContain(rotated.body.refresh_token);

		const stored = await c.env.kv.get(KvConst.MCP_OAUTH_DEVICE + devices[0].deviceId, { type: 'json' });
		expect(stored.accessToken).toBe(rotated.body.access_token);
		expect(stored.refreshToken).toBe(rotated.body.refresh_token);
		const access = await c.env.kv.get(KvConst.MCP_OAUTH_ACCESS + rotated.body.access_token, { type: 'json' });
		expect(access.deviceId).toBe(devices[0].deviceId);

		const again = await exchangeToken(c, {
			grant_type: 'refresh_token',
			refresh_token: rotated.body.refresh_token,
			client_id: clientId
		}, null);
		expect(again.status).toBe(200);
		const after = await listDevices(c);
		expect(after).toHaveLength(1);
		expect(after[0].deviceId).toBe(devices[0].deviceId);
	});

	it('lists devices by lastUsedAt descending', async () => {
		const c = context({ url: 'https://mail.example/oauth/token' });
		const clientId = (await registerPublic(c)).body.client_id;
		await exchangeSeededCode(c, {
			code: 'order-a',
			clientId,
			deviceId: 'device-older',
			userAgent: 'A'
		});
		await exchangeSeededCode(c, {
			code: 'order-b',
			clientId,
			deviceId: 'device-newer',
			userAgent: 'B'
		});
		const older = await c.env.kv.get(KvConst.MCP_OAUTH_DEVICE + 'device-older', { type: 'json' });
		older.lastUsedAt = Date.now() - 5000;
		await c.env.kv.put(KvConst.MCP_OAUTH_DEVICE + 'device-older', JSON.stringify(older));
		const devices = await listDevices(c);
		expect(devices.map((item) => item.deviceId)).toEqual(['device-newer', 'device-older']);
	});
});
