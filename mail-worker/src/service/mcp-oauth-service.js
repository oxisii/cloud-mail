import KvConst from '../const/kv-const';
import { isDel, userConst } from '../const/entity-const';
import apiResult from '../model/result';
import cryptoUtils from '../utils/crypto-utils';
import reqUtils from '../utils/req-utils';
import userService from './user-service';
import settingService from './setting-service';
import { authorizeMcpToken } from './mcp-service';
import constant from '../const/constant';

const CODE_TTL = 600;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const FAIL_TTL = 3600;
const FAIL_LIMIT = 10;
const SCOPE = 'mcp';

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];
const GRANT_TYPES = ['authorization_code', 'refresh_token'];
const HIDDEN_SKIP = new Set(['email', 'password']);

const LOGIN_FAIL = '邮箱或密码错误，或该账号不是管理员 / Email or password is incorrect, or the account is not the administrator';
const TOO_MANY = '尝试次数过多，请一小时后再试 / Too many attempts. Try again in an hour';

const NO_STORE = { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' };

function bytesToBase64Url(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomToken(size = 32) {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

export async function codeChallengeS256(verifier) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return bytesToBase64Url(new Uint8Array(digest));
}

function safeEqual(left, right) {
	if (typeof left !== 'string' || typeof right !== 'string') {
		return false;
	}
	const length = Math.max(left.length, right.length);
	let diff = left.length ^ right.length;
	for (let i = 0; i < length; i++) {
		diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
	}
	return diff === 0;
}

function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function originOf(c) {
	return new URL(c.req.url).origin;
}

function presentedToken(authorization) {
	let token = typeof authorization === 'string' ? authorization.trim() : '';
	if (token.toLowerCase().startsWith('bearer ')) {
		token = token.slice(7).trim();
	}
	return token;
}

function sameEmail(left, right) {
	return typeof left === 'string'
		&& typeof right === 'string'
		&& left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isPkceVerifier(value) {
	return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

function isS256Challenge(value) {
	return typeof value === 'string' && /^[A-Za-z0-9\-_]{43}$/.test(value);
}

function oauthError(status, error, description, basic = false) {
	const headers = { ...NO_STORE };
	if (status === 401 && basic) {
		headers['WWW-Authenticate'] = 'Basic realm="mcp"';
	}
	return { status, body: { error, error_description: description }, headers };
}

function invalidMetadata(description) {
	return oauthError(400, 'invalid_client_metadata', description);
}

export function protectedResourceMetadata(origin) {
	return {
		resource: `${origin}/mcp`,
		authorization_servers: [origin],
		bearer_methods_supported: ['header'],
		scopes_supported: [SCOPE],
		resource_name: 'Cloud Mail MCP'
	};
}

export function authorizationServerMetadata(origin) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		registration_endpoint: `${origin}/oauth/register`,
		revocation_endpoint: `${origin}/oauth/revoke`,
		response_types_supported: ['code'],
		grant_types_supported: [...GRANT_TYPES],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: [...AUTH_METHODS],
		scopes_supported: [SCOPE]
	};
}

export function mcpWwwAuthenticate(origin) {
	return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

function isAllowedRedirect(uri) {
	if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) {
		return false;
	}
	if (/[\u0000-\u001F\u007F]/.test(uri)) {
		return false;
	}
	let url;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.hash || url.username || url.password) {
		return false;
	}
	if (url.protocol === 'https:') {
		return true;
	}
	if (url.protocol !== 'http:') {
		return false;
	}
	const host = url.hostname.toLowerCase();
	return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function normalizeStringList(value) {
	if (!Array.isArray(value)) {
		return null;
	}
	const list = [];
	for (const item of value) {
		if (typeof item !== 'string') {
			return null;
		}
		if (!list.includes(item)) {
			list.push(item);
		}
	}
	return list;
}

export async function registerClient(c, metadata) {
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return invalidMetadata('metadata must be a JSON object');
	}

	const redirectUris = normalizeStringList(metadata.redirect_uris);
	if (!redirectUris || redirectUris.length === 0 || redirectUris.length > 16) {
		return invalidMetadata('redirect_uris must be a non-empty array of URLs');
	}
	if (redirectUris.some((uri) => !isAllowedRedirect(uri))) {
		return invalidMetadata('redirect_uris must be https, or http on localhost, 127.0.0.1, or [::1]');
	}

	let grantTypes = [...GRANT_TYPES];
	if (metadata.grant_types != null) {
		grantTypes = normalizeStringList(metadata.grant_types);
		if (!grantTypes || grantTypes.length === 0 || grantTypes.some((item) => !GRANT_TYPES.includes(item))) {
			return invalidMetadata('grant_types must be authorization_code and refresh_token');
		}
		if (!grantTypes.includes('authorization_code')) {
			return invalidMetadata('grant_types must include authorization_code');
		}
	}

	if (metadata.response_types != null) {
		const responseTypes = normalizeStringList(metadata.response_types);
		if (!responseTypes || responseTypes.length === 0 || responseTypes.some((item) => item !== 'code')) {
			return invalidMetadata('response_types must be code');
		}
	}

	let authMethod = 'none';
	if (metadata.token_endpoint_auth_method != null) {
		if (typeof metadata.token_endpoint_auth_method !== 'string' || !AUTH_METHODS.includes(metadata.token_endpoint_auth_method)) {
			return invalidMetadata('token_endpoint_auth_method is not supported');
		}
		authMethod = metadata.token_endpoint_auth_method;
	}

	if (metadata.scope != null && metadata.scope !== '' && metadata.scope !== SCOPE) {
		return invalidMetadata('scope must be mcp');
	}

	let clientName = '';
	if (metadata.client_name != null && metadata.client_name !== '') {
		if (typeof metadata.client_name !== 'string' || metadata.client_name.length > 256) {
			return invalidMetadata('client_name must be a string');
		}
		clientName = metadata.client_name;
	}

	const clientId = randomToken(32);
	const issuedAt = Math.floor(Date.now() / 1000);
	const record = {
		clientId,
		redirectUris,
		clientName,
		grantTypes,
		tokenEndpointAuthMethod: authMethod,
		responseTypes: ['code'],
		createdAt: issuedAt
	};

	const body = {
		client_id: clientId,
		client_id_issued_at: issuedAt,
		redirect_uris: redirectUris,
		grant_types: grantTypes,
		response_types: ['code'],
		token_endpoint_auth_method: authMethod
	};
	if (clientName) {
		body.client_name = clientName;
	}

	if (authMethod !== 'none') {
		const secret = randomToken(32);
		const hashed = await cryptoUtils.hashPassword(secret);
		record.secretSalt = hashed.salt;
		record.secretHash = hashed.hash;
		body.client_secret = secret;
		body.client_secret_expires_at = 0;
	}

	await c.env.kv.put(KvConst.MCP_OAUTH_CLIENT + clientId, JSON.stringify(record));
	return { status: 201, body, headers: { ...NO_STORE } };
}

async function loadClient(c, clientId) {
	if (!clientId || typeof clientId !== 'string') {
		return null;
	}
	return c.env.kv.get(KvConst.MCP_OAUTH_CLIENT + clientId, { type: 'json' });
}

function denyAuthorize(reason) {
	return {
		status: 400,
		text: `OAuth 授权参数无效 / Invalid authorization request: ${reason}`
	};
}

async function validateAuthorize(c, params) {
	if (!params || params.response_type !== 'code') {
		return denyAuthorize('response_type must be code');
	}
	if (!params.client_id) {
		return denyAuthorize('client_id is required');
	}
	if (!params.redirect_uri) {
		return denyAuthorize('redirect_uri is required');
	}
	if (!isS256Challenge(params.code_challenge)) {
		return denyAuthorize('code_challenge is required and must be S256');
	}
	if (params.code_challenge_method !== 'S256') {
		return denyAuthorize('code_challenge_method must be S256');
	}
	if (params.scope != null && params.scope !== '' && params.scope !== SCOPE) {
		return denyAuthorize('scope must be mcp');
	}
	if (params.resource != null && params.resource !== '' && params.resource !== `${originOf(c)}/mcp`) {
		return denyAuthorize('resource must be the MCP endpoint');
	}

	const client = await loadClient(c, params.client_id);
	if (!client) {
		return denyAuthorize('client_id is not registered');
	}
	if (!Array.isArray(client.redirectUris) || !client.redirectUris.includes(params.redirect_uri)) {
		return denyAuthorize('redirect_uri does not match the registered value');
	}
	return { ok: true, client };
}

async function siteTitle(c) {
	try {
		const row = await settingService.query(c);
		const title = typeof row?.title === 'string' ? row.title.trim() : '';
		return title || 'Cloud Mail';
	} catch {
		return 'Cloud Mail';
	}
}

function hiddenFields(params) {
	const fields = [];
	const used = new Set();
	const preferred = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];
	const entries = [
		...preferred.filter((key) => typeof params?.[key] === 'string').map((key) => [key, params[key]]),
		...Object.entries(params || {})
	];
	for (const [key, value] of entries) {
		if (HIDDEN_SKIP.has(key) || used.has(key) || typeof value !== 'string') {
			continue;
		}
		if (key.length > 64 || value.length > 2048) {
			continue;
		}
		used.add(key);
		fields.push(`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`);
		if (fields.length >= 32) {
			break;
		}
	}
	return fields.join('');
}

function pageShell(title, body) {
	return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#f4f5f7;font-family:system-ui,sans-serif;color:#1f2328}
main{max-width:400px;margin:10vh auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}
p{color:#59636e;font-size:13px;line-height:1.5;margin:0 0 12px}
label{display:block;font-size:13px;margin:12px 0 6px}
input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d0d7de;border-radius:8px;font-size:14px}
button{width:100%;margin-top:18px;padding:10px;border:0;border-radius:8px;background:#1677ff;color:#fff;font-size:14px;cursor:pointer}
.err{color:#cf1322;background:#fff1f0;padding:8px 10px;border-radius:8px;font-size:13px;margin:0 0 8px}
.meta{word-break:break-all}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>`;
}

function loginPage({ title, params, client, error }) {
	const name = client?.clientName || client?.clientId || '';
	const errorHtml = error ? `<div class="err">${escapeHtml(error)}</div>` : '';
	const body = `<p>管理员登录并授权 MCP / Administrator sign-in to authorize MCP</p>
<p class="meta">客户端 / Client: ${escapeHtml(name)}</p>
<p class="meta">回调地址 / Redirect: ${escapeHtml(params.redirect_uri || '')}</p>
${errorHtml}
<form method="post" action="/oauth/authorize" accept-charset="UTF-8">
${hiddenFields(params)}
<label for="email">邮箱 / Email</label>
<input id="email" name="email" type="email" required maxlength="320" autocomplete="username" value="${escapeHtml(params.email || '')}">
<label for="password">密码 / Password</label>
<input id="password" name="password" type="password" required maxlength="200" autocomplete="current-password">
<button type="submit">授权 / Authorize</button>
</form>`;
	return pageShell(title, body);
}

function messagePage(title, message) {
	return pageShell(title, `<p>${escapeHtml(message)}</p>`);
}

function failKey(email, ip) {
	return KvConst.MCP_OAUTH_FAIL + String(email || '').trim().toLowerCase() + ':' + (ip || 'unknown');
}

async function failureCount(c, email, ip) {
	const raw = await c.env.kv.get(failKey(email, ip), { type: 'json' });
	const count = Number(raw?.count || 0);
	return Number.isFinite(count) ? count : 0;
}

async function recordFailure(c, email, ip) {
	const count = await failureCount(c, email, ip);
	await c.env.kv.put(failKey(email, ip), JSON.stringify({ count: count + 1 }), { expirationTtl: FAIL_TTL });
}

export async function authorizeGet(c, params) {
	const check = await validateAuthorize(c, params);
	if (!check.ok) {
		return check;
	}
	const title = await siteTitle(c);
	return { status: 200, html: loginPage({ title, params, client: check.client, error: '' }) };
}

export async function authorizePost(c, params) {
	const check = await validateAuthorize(c, params);
	if (!check.ok) {
		return check;
	}

	const email = typeof params.email === 'string' ? params.email.trim() : '';
	const password = typeof params.password === 'string' ? params.password : '';
	const ip = reqUtils.getIp(c);
	if (await failureCount(c, email, ip) >= FAIL_LIMIT) {
		const title = await siteTitle(c);
		return { status: 429, html: messagePage(title, TOO_MANY) };
	}

	const verdict = await verifyAdmin(c, email, password);
	if (verdict.fatal) {
		return { status: 500, text: 'Internal error' };
	}
	if (!verdict.ok) {
		await recordFailure(c, email, ip);
		const title = await siteTitle(c);
		return {
			status: 200,
			html: loginPage({
				title,
				params: { ...params, email },
				client: check.client,
				error: LOGIN_FAIL
			})
		};
	}

	await c.env.kv.delete(failKey(email, ip));
	const code = randomToken(32);
	await c.env.kv.put(KvConst.MCP_OAUTH_CODE + code, JSON.stringify({
		clientId: check.client.clientId,
		redirectUri: params.redirect_uri,
		codeChallenge: params.code_challenge,
		resource: params.resource || '',
		scope: SCOPE,
		createdAt: Date.now()
	}), { expirationTtl: CODE_TTL });

	const location = new URL(params.redirect_uri);
	location.searchParams.set('code', code);
	if (Object.prototype.hasOwnProperty.call(params, 'state')) {
		location.searchParams.set('state', params.state);
	}
	return { status: 302, location: location.href };
}

async function verifyAdmin(c, email, password) {
	const admin = c.env?.admin;
	if (!email || !password || !sameEmail(email, admin)) {
		return { ok: false };
	}
	let userRow;
	try {
		userRow = await userService.selectByEmailIncludeDel(c, email);
	} catch (error) {
		console.error(error);
		return { ok: false, fatal: true };
	}
	if (!userRow || userRow.isDel === isDel.DELETE || userRow.status !== userConst.status.NORMAL || !sameEmail(userRow.email, admin)) {
		return { ok: false };
	}
	try {
		if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			return { ok: false };
		}
	} catch (error) {
		console.error(error);
		return { ok: false, fatal: true };
	}
	return { ok: true };
}

export function parseBasicAuth(header) {
	if (typeof header !== 'string' || !header.toLowerCase().startsWith('basic ')) {
		return null;
	}
	try {
		const decoded = atob(header.slice(6).trim());
		const index = decoded.indexOf(':');
		if (index < 0) {
			return { invalid: true };
		}
		return {
			clientId: decodeURIComponent(decoded.slice(0, index)),
			clientSecret: decodeURIComponent(decoded.slice(index + 1))
		};
	} catch {
		return { invalid: true };
	}
}

async function authenticateClient(c, params, basic) {
	if (basic?.invalid) {
		return { ok: false, error: oauthError(401, 'invalid_client', 'Client authentication failed', true) };
	}

	const bodyId = typeof params.client_id === 'string' ? params.client_id : '';
	const bodySecret = typeof params.client_secret === 'string' ? params.client_secret : '';
	let clientId = bodyId;
	let clientSecret = bodySecret;
	let usedBasic = false;

	if (basic?.clientId) {
		usedBasic = true;
		if ((bodyId && bodyId !== basic.clientId) || (bodySecret && basic.clientSecret && bodySecret !== basic.clientSecret)) {
			return { ok: false, error: oauthError(400, 'invalid_request', 'Multiple client credentials were provided') };
		}
		clientId = basic.clientId;
		clientSecret = basic.clientSecret || bodySecret;
	}

	if (!clientId) {
		return { ok: false, error: oauthError(401, 'invalid_client', 'Client authentication failed', usedBasic) };
	}

	const client = await loadClient(c, clientId);
	if (!client) {
		return { ok: false, error: oauthError(401, 'invalid_client', 'Client authentication failed', usedBasic) };
	}
	if (client.secretHash) {
		const matches = clientSecret
			? await cryptoUtils.verifyPassword(clientSecret, client.secretSalt, client.secretHash)
			: false;
		if (!matches) {
			return { ok: false, error: oauthError(401, 'invalid_client', 'Client authentication failed', usedBasic) };
		}
	}
	return { ok: true, client };
}

async function issueTokens(c, client) {
	const access = randomToken(32);
	const refresh = randomToken(32);
	const createdAt = Date.now();
	const accessRecord = JSON.stringify({ clientId: client.clientId, createdAt });
	const refreshRecord = JSON.stringify({ clientId: client.clientId, createdAt });
	await c.env.kv.put(KvConst.MCP_OAUTH_ACCESS + access, accessRecord, { expirationTtl: ACCESS_TTL });
	await c.env.kv.put(KvConst.MCP_OAUTH_REFRESH + refresh, refreshRecord, { expirationTtl: REFRESH_TTL });
	return {
		status: 200,
		headers: { ...NO_STORE },
		body: {
			access_token: access,
			token_type: 'Bearer',
			expires_in: ACCESS_TTL,
			refresh_token: refresh,
			scope: SCOPE
		}
	};
}

async function exchangeCode(c, params, client) {
	const code = typeof params.code === 'string' ? params.code : '';
	const redirectUri = typeof params.redirect_uri === 'string' ? params.redirect_uri : '';
	const verifier = typeof params.code_verifier === 'string' ? params.code_verifier : '';
	if (!code || !redirectUri || !verifier) {
		return oauthError(400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
	}

	const key = KvConst.MCP_OAUTH_CODE + code;
	const record = await c.env.kv.get(key, { type: 'json' });
	// 授权码一次性：取出后立即删除，PKCE 失败也不能再换
	await c.env.kv.delete(key);
	if (!record || record.clientId !== client.clientId || record.redirectUri !== redirectUri) {
		return oauthError(400, 'invalid_grant', 'Authorization code is invalid');
	}
	if (!isPkceVerifier(verifier)) {
		return oauthError(400, 'invalid_grant', 'code_verifier is invalid');
	}
	const challenge = await codeChallengeS256(verifier);
	if (!safeEqual(challenge, record.codeChallenge)) {
		return oauthError(400, 'invalid_grant', 'PKCE verification failed');
	}
	return issueTokens(c, client);
}

async function exchangeRefresh(c, params, client) {
	const refresh = typeof params.refresh_token === 'string' ? params.refresh_token : '';
	if (!refresh) {
		return oauthError(400, 'invalid_request', 'refresh_token is required');
	}
	const key = KvConst.MCP_OAUTH_REFRESH + refresh;
	const record = await c.env.kv.get(key, { type: 'json' });
	if (!record || record.clientId !== client.clientId) {
		return oauthError(400, 'invalid_grant', 'Refresh token is invalid');
	}
	await c.env.kv.delete(key);
	return issueTokens(c, client);
}

export async function exchangeToken(c, params, basic) {
	const grant = params?.grant_type;
	if (!grant) {
		return oauthError(400, 'invalid_request', 'grant_type is required');
	}
	if (grant !== 'authorization_code' && grant !== 'refresh_token') {
		return oauthError(400, 'unsupported_grant_type', 'grant_type is not supported');
	}

	const auth = await authenticateClient(c, params, basic);
	if (!auth.ok) {
		return auth.error;
	}

	if (params.resource != null && params.resource !== '' && params.resource !== `${originOf(c)}/mcp`) {
		return oauthError(400, 'invalid_target', 'resource must be the MCP endpoint');
	}

	if (grant === 'authorization_code') {
		return exchangeCode(c, params, auth.client);
	}
	return exchangeRefresh(c, params, auth.client);
}

export async function revokeToken(c, params) {
	const token = typeof params?.token === 'string' ? params.token : '';
	if (token) {
		await c.env.kv.delete(KvConst.MCP_OAUTH_ACCESS + token);
		await c.env.kv.delete(KvConst.MCP_OAUTH_REFRESH + token);
	}
	return { status: 200, empty: true };
}

export async function authorizeMcp(c, settingRow) {
	const authorization = c.req.header(constant.TOKEN_HEADER);
	const staticAuth = authorizeMcpToken({
		mcpStatus: settingRow?.mcpStatus,
		mcpToken: settingRow?.mcpToken,
		authorization
	});
	if (staticAuth.ok || staticAuth.status === 403) {
		return staticAuth;
	}

	const token = presentedToken(authorization);
	if (token && c.env?.kv) {
		try {
			const record = await c.env.kv.get(KvConst.MCP_OAUTH_ACCESS + token, { type: 'json' });
			if (record?.clientId) {
				return { ok: true };
			}
		} catch (error) {
			console.error(error);
		}
	}
	return staticAuth;
}

export function respondMcpAuthFailure(c, auth) {
	const headers = {};
	if (auth.status === 401) {
		headers['WWW-Authenticate'] = mcpWwwAuthenticate(originOf(c));
	}
	return c.json(apiResult.fail(auth.message, auth.status), auth.status, headers);
}

const mcpOauthService = {
	protectedResourceMetadata,
	authorizationServerMetadata,
	codeChallengeS256,
	registerClient,
	authorizeGet,
	authorizePost,
	exchangeToken,
	revokeToken,
	authorizeMcp,
	respondMcpAuthFailure,
	parseBasicAuth,
	mcpWwwAuthenticate
};

export default mcpOauthService;
