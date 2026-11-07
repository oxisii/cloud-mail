import { describe, expect, it } from 'vitest';
import mcpService, { authorizeMcpToken, dispatch } from '../src/service/mcp-service.js';

const TOOL_NAMES = [
	'email_list',
	'email_latest',
	'email_read',
	'email_send',
	'email_delete',
	'email_att_list',
	'all_email_list',
	'all_email_latest',
	'all_email_delete',
	'all_email_batch_delete',
	'public_email_list',
	'public_add_user',
	'account_list',
	'account_add',
	'account_set_name',
	'account_set_all_receive',
	'account_set_as_top',
	'account_delete',
	'user_list',
	'user_all_account',
	'user_add',
	'user_set_pwd',
	'user_set_status',
	'user_set_type',
	'user_reset_send_count',
	'user_restore',
	'user_delete',
	'user_delete_account',
	'role_list',
	'role_tree',
	'role_select_use',
	'role_add',
	'role_set',
	'role_set_default',
	'role_delete',
	'reg_key_list',
	'reg_key_history',
	'reg_key_add',
	'reg_key_delete',
	'reg_key_clear_not_use',
	'star_list',
	'star_add',
	'star_cancel',
	'setting_query',
	'setting_website_config',
	'setting_set',
	'setting_set_blacklist',
	'analysis_echarts',
	'my_login_user_info'
];

describe('mcp token check', () => {
	it('rejects a disabled service with 403', () => {
		const result = authorizeMcpToken({ mcpStatus: 1, mcpToken: 'token-a', authorization: 'token-a' });
		expect(result.ok).toBe(false);
		expect(result.status).toBe(403);
		expect(result.message).toBeTruthy();
	});

	it('rejects a missing, empty, or wrong token with 401', () => {
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: '', authorization: 'token-a' }).status).toBe(401);
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: 'token-a', authorization: '' }).status).toBe(401);
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: 'token-a' }).status).toBe(401);
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: 'token-a', authorization: 'token-b' }).status).toBe(401);
	});

	it('accepts the raw token and an optional Bearer prefix', () => {
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: 'token-a', authorization: 'token-a' }).ok).toBe(true);
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: 'token-a', authorization: 'Bearer token-a' }).ok).toBe(true);
		expect(authorizeMcpToken({ mcpStatus: 0, mcpToken: 'token-a', authorization: 'bearer token-a' }).ok).toBe(true);
	});
});

describe('mcp json-rpc', () => {
	it('echoes the client protocol version and defaults when it is absent', async () => {
		const echoed = await dispatch(null, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18' }
		});
		expect(echoed.status).toBe(200);
		expect(echoed.body.result.protocolVersion).toBe('2025-06-18');
		expect(echoed.body.result.capabilities.tools).toEqual({});
		expect(echoed.body.result.serverInfo).toEqual({ name: 'cloud-mail', version: '1.0.0' });

		const fallback = await dispatch(null, { jsonrpc: '2.0', id: 2, method: 'initialize' });
		expect(fallback.body.result.protocolVersion).toBe('2025-03-26');
	});

	it('answers ping with an empty object', async () => {
		const result = await dispatch(null, { jsonrpc: '2.0', id: 3, method: 'ping' });
		expect(result.body.result).toEqual({});
	});

	it('lists the 49 registered tools', async () => {
		const result = await dispatch(null, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
		const names = result.body.result.tools.map(tool => tool.name);
		expect(names).toEqual(TOOL_NAMES);
		expect(mcpService.toolCount()).toBe(49);
		expect(new Set(names).size).toBe(49);
		for (const tool of result.body.result.tools) {
			expect(tool.description).toMatch(/\s(GET|POST|PUT|DELETE) \/\S+$/);
			expect(tool.inputSchema.type).toBe('object');
			expect(tool.annotations).toEqual(expect.objectContaining({
				readOnlyHint: expect.any(Boolean),
				destructiveHint: expect.any(Boolean)
			}));
		}
	});

	it('returns method-not-found and unknown-tool errors', async () => {
		const method = await dispatch(null, { jsonrpc: '2.0', id: 5, method: 'resources/list' });
		expect(method.body.error.code).toBe(-32601);

		const tool = await dispatch(null, {
			jsonrpc: '2.0',
			id: 6,
			method: 'tools/call',
			params: { name: 'not_a_tool', arguments: {} }
		});
		expect(tool.body.error.code).toBe(-32602);
	});

	it('returns invalid params when a required argument is missing', async () => {
		const result = await dispatch(null, {
			jsonrpc: '2.0',
			id: 7,
			method: 'tools/call',
			params: { name: 'email_delete', arguments: {} }
		});
		expect(result.body.error.code).toBe(-32602);
	});

	it('returns 204 for notifications', async () => {
		const result = await dispatch(null, { jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(result.status).toBe(204);
		expect(result.body).toBeNull();
	});

	it('returns a parse error for illegal JSON', async () => {
		const calls = [];
		await mcpService.handle({
			req: {
				text: async () => '{not json'
			},
			json(body, status) {
				calls.push({ body, status });
			},
			body(body, status) {
				calls.push({ body, status });
			}
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].body.error.code).toBe(-32700);
	});
});
