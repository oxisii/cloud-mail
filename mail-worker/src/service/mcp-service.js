import BizError from '../error/biz-error';
import userContext from '../security/user-context';
import emailService from './email-service';
import attService from './att-service';
import publicService from './public-service';
import accountService from './account-service';
import userService from './user-service';
import roleService from './role-service';
import permService from './perm-service';
import regKeyService from './reg-key-service';
import starService from './star-service';
import settingService from './setting-service';
import analysisService from './analysis-service';
import { t } from '../i18n/i18n';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_VERSION = '1.0.0';

const READ = { readOnlyHint: true, destructiveHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true };

function schema(properties = {}, required = []) {
	return {
		type: 'object',
		properties,
		required,
		additionalProperties: true
	};
}

function str(description) {
	return { type: 'string', description };
}

function int(description) {
	return { type: 'integer', description };
}

function arr(items, description) {
	return { type: 'array', description, items };
}

function userId(c) {
	return userContext.getUserId(c);
}

function rpcOk(id, result) {
	return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id, code, message) {
	return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// MCP 令牌等同管理员权限。调用方在校验通过后注入管理员用户行。
export function authorizeMcpToken({ mcpStatus, mcpToken, authorization }) {
	if (mcpStatus !== 0) {
		return { ok: false, status: 403, message: t('mcpDisabled') };
	}

	let token = typeof authorization === 'string' ? authorization.trim() : '';
	if (token.toLowerCase().startsWith('bearer ')) {
		token = token.slice(7).trim();
	}

	if (!mcpToken || !token || token !== mcpToken) {
		return { ok: false, status: 401, message: t('mcpTokenFail') };
	}

	return { ok: true };
}

const tools = [
	{
		name: 'email_list',
		description: 'List messages in the administrator mailbox. GET /email/list',
		inputSchema: schema({
			emailId: int('Cursor email id, 0 to start from the latest'),
			type: int('0 receive, 1 send'),
			accountId: int('Mailbox account id'),
			size: int('Page size, max 50'),
			timeSort: int('1 ascending by email id, otherwise descending'),
			allReceive: int('1 to include every mailbox of the user'),
			full: int('1 returns full content, 0 returns a brief row'),
			text: str('Search text'),
			searchType: str('Search field'),
			startDate: str('Range start'),
			endDate: str('Range end')
		}, ['accountId']),
		annotations: READ,
		handler: (c, args) => emailService.list(c, args, userId(c))
	},
	{
		name: 'email_latest',
		description: 'List newly received messages after an email id. GET /email/latest',
		inputSchema: schema({
			emailId: int('Return messages with a greater email id'),
			accountId: int('Mailbox account id'),
			allReceive: int('1 to include every mailbox of the user')
		}),
		annotations: READ,
		handler: (c, args) => emailService.latest(c, args, userId(c))
	},
	{
		name: 'email_read',
		description: 'Mark messages as read. PUT /email/read',
		inputSchema: schema({
			emailIds: arr({ type: 'integer' }, 'Email ids')
		}, ['emailIds']),
		annotations: WRITE,
		handler: (c, args) => emailService.read(c, args, userId(c))
	},
	{
		name: 'email_send',
		description: 'Send or reply to a message. Attachments are passed through unchanged. POST /email/send',
		inputSchema: schema({
			accountId: int('Sender account id'),
			name: str('Sender display name'),
			sendType: str('Use reply when answering an existing message'),
			emailId: int('Original email id when sendType is reply'),
			receiveEmail: arr({ type: 'string' }, 'Recipient addresses'),
			manyType: str('divide sends one message per recipient'),
			text: str('Plain text body'),
			content: str('HTML body'),
			subject: str('Subject'),
			attachments: arr({
				type: 'object',
				properties: {
					filename: str('File name'),
					content: str('Base64 content or a data URL'),
					mimeType: str('MIME type'),
					contentType: str('MIME type'),
					contentId: str('Inline content id')
				}
			}, 'Attachments, same shape as the send API')
		}, ['accountId', 'receiveEmail']),
		annotations: WRITE,
		handler: (c, args) => emailService.send(c, args, userId(c))
	},
	{
		name: 'email_delete',
		description: 'Delete messages owned by the administrator. DELETE /email/delete',
		inputSchema: schema({
			emailIds: str('Comma-separated email ids')
		}, ['emailIds']),
		annotations: DESTROY,
		handler: (c, args) => emailService.delete(c, args, userId(c))
	},
	{
		name: 'email_att_list',
		description: 'List attachment metadata for one message. File bytes stay on the original storage URL. GET /email/attList',
		inputSchema: schema({
			emailId: int('Email id')
		}, ['emailId']),
		annotations: READ,
		handler: (c, args) => attService.list(c, args, userId(c))
	},
	{
		name: 'all_email_list',
		description: 'List messages across the whole site. GET /allEmail/list',
		inputSchema: schema({
			emailId: int('Cursor email id'),
			size: int('Page size, max 50'),
			name: str('Sender name filter'),
			subject: str('Subject filter'),
			accountEmail: str('Mailbox address filter'),
			userEmail: str('Owner address filter'),
			type: str('receive or send, default receive'),
			timeSort: int('1 ascending by email id, otherwise descending'),
			full: int('1 returns full content, 0 returns a brief row')
		}),
		annotations: READ,
		handler: (c, args) => emailService.allList(c, args)
	},
	{
		name: 'all_email_latest',
		description: 'List newly received messages across the whole site. GET /allEmail/latest',
		inputSchema: schema({
			emailId: int('Return messages with a greater email id')
		}),
		annotations: READ,
		handler: (c, args) => emailService.allEmailLatest(c, args)
	},
	{
		name: 'all_email_delete',
		description: 'Physically delete site messages by id. DELETE /allEmail/delete',
		inputSchema: schema({
			emailIds: str('Comma-separated email ids')
		}, ['emailIds']),
		annotations: DESTROY,
		handler: (c, args) => emailService.physicsDelete(c, args)
	},
	{
		name: 'all_email_batch_delete',
		description: 'Physically delete site messages that match the filters. DELETE /allEmail/batchDelete',
		inputSchema: schema({
			sendName: str('Sender name'),
			sendEmail: str('Sender address'),
			toEmail: str('Recipient address'),
			subject: str('Subject'),
			startTime: str('Created at or after, YYYY-MM-DD HH:mm:ss'),
			endTime: str('Created at or before, YYYY-MM-DD HH:mm:ss'),
			type: str('eq exact, left prefix, include contains')
		}),
		annotations: DESTROY,
		handler: (c, args) => emailService.batchDelete(c, args)
	},
	{
		name: 'public_email_list',
		description: 'Query messages with the public email list filters. POST /public/emailList',
		inputSchema: schema({
			toEmail: str('Recipient address, case-insensitive LIKE'),
			content: str('HTML content LIKE'),
			subject: str('Subject LIKE'),
			sendName: str('Sender name LIKE'),
			sendEmail: str('Sender address LIKE'),
			timeSort: str('asc or omit for newest first'),
			num: int('Page number, starting at 1'),
			size: int('Page size, default 20'),
			type: int('Message type'),
			isDel: int('0 normal, 1 deleted')
		}),
		annotations: READ,
		handler: (c, args) => publicService.emailList(c, args)
	},
	{
		name: 'public_add_user',
		description: 'Create users in batch. POST /public/addUser',
		inputSchema: schema({
			list: arr({
				type: 'object',
				properties: {
					email: str('User email on a configured domain'),
					password: str('Password, a random one is used when omitted'),
					roleName: str('Role name, the default role is used when omitted')
				},
				required: ['email']
			}, 'Users to create')
		}, ['list']),
		annotations: WRITE,
		handler: (c, args) => publicService.addUser(c, args)
	},
	{
		name: 'account_list',
		description: 'List mailboxes of the administrator. GET /account/list',
		inputSchema: schema({
			accountId: int('Cursor account id'),
			size: int('Page size, max 30'),
			lastSort: int('Cursor sort value')
		}),
		annotations: READ,
		handler: (c, args) => accountService.list(c, args, userId(c))
	},
	{
		name: 'account_add',
		description: 'Add a mailbox for the administrator. POST /account/add',
		inputSchema: schema({
			email: str('Mailbox address'),
			token: str('Turnstile token when add verification is enabled')
		}, ['email']),
		annotations: WRITE,
		handler: (c, args) => accountService.add(c, args, userId(c))
	},
	{
		name: 'account_set_name',
		description: 'Rename a mailbox. PUT /account/setName',
		inputSchema: schema({
			accountId: int('Account id'),
			name: str('Display name, at most 30 characters')
		}, ['accountId', 'name']),
		annotations: WRITE,
		handler: (c, args) => accountService.setName(c, args, userId(c))
	},
	{
		name: 'account_set_all_receive',
		description: 'Toggle whether a mailbox receives mail for every address of the user. PUT /account/setAllReceive',
		inputSchema: schema({
			accountId: int('Account id')
		}, ['accountId']),
		annotations: WRITE,
		handler: (c, args) => accountService.setAllReceive(c, args, userId(c))
	},
	{
		name: 'account_set_as_top',
		description: 'Pin a mailbox to the top of the list. PUT /account/setAsTop',
		inputSchema: schema({
			accountId: int('Account id')
		}, ['accountId']),
		annotations: WRITE,
		handler: (c, args) => accountService.setAsTop(c, args, userId(c))
	},
	{
		name: 'account_delete',
		description: 'Delete a mailbox of the administrator. DELETE /account/delete',
		inputSchema: schema({
			accountId: int('Account id')
		}, ['accountId']),
		annotations: DESTROY,
		handler: (c, args) => accountService.delete(c, args, userId(c))
	},
	{
		name: 'user_list',
		description: 'List users. GET /user/list',
		inputSchema: schema({
			num: int('Page number, starting at 1'),
			size: int('Page size, max 50'),
			email: str('Email prefix'),
			timeSort: int('1 ascending by user id, otherwise descending'),
			status: int('0 normal, 1 banned, -1 to skip the status filter'),
			isDel: int('1 lists deleted users')
		}),
		annotations: READ,
		handler: (c, args) => userService.list(c, args, userId(c))
	},
	{
		name: 'user_all_account',
		description: 'List mailboxes of one user. GET /user/allAccount',
		inputSchema: schema({
			userId: int('User id'),
			num: int('Page number, starting at 1'),
			size: int('Page size, max 30')
		}, ['userId']),
		annotations: READ,
		handler: (c, args) => accountService.allAccount(c, args)
	},
	{
		name: 'user_add',
		description: 'Create one user. POST /user/add',
		inputSchema: schema({
			email: str('User email on a configured domain'),
			password: str('Password, at least 6 characters'),
			type: int('Role id, the default role is used when omitted')
		}, ['email', 'password']),
		annotations: WRITE,
		handler: (c, args) => userService.add(c, args)
	},
	{
		name: 'user_set_pwd',
		description: 'Set a user password. This is a sensitive credential change. PUT /user/setPwd',
		inputSchema: schema({
			userId: int('User id'),
			password: str('New password, at least 6 characters')
		}, ['userId', 'password']),
		annotations: WRITE,
		handler: (c, args) => userService.setPwd(c, args)
	},
	{
		name: 'user_set_status',
		description: 'Ban or enable a user. PUT /user/setStatus',
		inputSchema: schema({
			userId: int('User id'),
			status: int('User status')
		}, ['userId', 'status']),
		annotations: WRITE,
		handler: (c, args) => userService.setStatus(c, args)
	},
	{
		name: 'user_set_type',
		description: 'Change a user role. PUT /user/setType',
		inputSchema: schema({
			userId: int('User id'),
			type: int('Role id')
		}, ['userId', 'type']),
		annotations: WRITE,
		handler: (c, args) => userService.setType(c, args)
	},
	{
		name: 'user_reset_send_count',
		description: 'Reset a user send counter. PUT /user/resetSendCount',
		inputSchema: schema({
			userId: int('User id')
		}, ['userId']),
		annotations: WRITE,
		handler: (c, args) => userService.resetSendCount(c, args)
	},
	{
		name: 'user_restore',
		description: 'Restore a deleted user. PUT /user/restore',
		inputSchema: schema({
			userId: int('User id'),
			type: int('When set, also restore deleted mail and mailboxes')
		}, ['userId']),
		annotations: WRITE,
		handler: (c, args) => userService.restore(c, args)
	},
	{
		name: 'user_delete',
		description: 'Physically delete users. DELETE /user/delete',
		inputSchema: schema({
			userIds: str('Comma-separated user ids')
		}, ['userIds']),
		annotations: DESTROY,
		handler: (c, args) => userService.physicsDelete(c, args)
	},
	{
		name: 'user_delete_account',
		description: 'Physically delete one mailbox. DELETE /user/deleteAccount',
		inputSchema: schema({
			accountId: int('Account id')
		}, ['accountId']),
		annotations: DESTROY,
		handler: (c, args) => accountService.physicsDelete(c, args)
	},
	{
		name: 'role_list',
		description: 'List roles and their permission ids. GET /role/list',
		inputSchema: schema(),
		annotations: READ,
		handler: (c) => roleService.roleList(c)
	},
	{
		name: 'role_tree',
		description: 'Return the permission tree. GET /role/tree',
		inputSchema: schema(),
		annotations: READ,
		handler: (c) => permService.tree(c)
	},
	{
		name: 'role_select_use',
		description: 'List roles for selectors. GET /role/selectUse',
		inputSchema: schema(),
		annotations: READ,
		handler: (c) => roleService.roleSelectUse(c)
	},
	{
		name: 'role_add',
		description: 'Create a role. POST /role/add',
		inputSchema: schema({
			name: str('Role name'),
			description: str('Description'),
			sort: int('Sort order'),
			permIds: arr({ type: 'integer' }, 'Permission ids'),
			banEmail: arr({ type: 'string' }, 'Blocked sender addresses, domains, or *'),
			availDomain: arr({ type: 'string' }, 'Allowed domains, empty means all'),
			sendType: str('count, day, ban, or internal'),
			sendCount: int('Send limit, 0 means unlimited'),
			accountCount: int('Mailbox limit, 0 means unlimited'),
			banEmailType: int('Block-list type')
		}, ['name', 'permIds', 'banEmail', 'availDomain']),
		annotations: WRITE,
		handler: (c, args) => roleService.add(c, args, userId(c))
	},
	{
		name: 'role_set',
		description: 'Update a role. PUT /role/set',
		inputSchema: schema({
			roleId: int('Role id'),
			name: str('Role name'),
			description: str('Description'),
			sort: int('Sort order'),
			permIds: arr({ type: 'integer' }, 'Permission ids'),
			banEmail: arr({ type: 'string' }, 'Blocked sender addresses, domains, or *'),
			availDomain: arr({ type: 'string' }, 'Allowed domains, empty means all'),
			sendType: str('count, day, ban, or internal'),
			sendCount: int('Send limit, 0 means unlimited'),
			accountCount: int('Mailbox limit, 0 means unlimited'),
			banEmailType: int('Block-list type')
		}, ['roleId', 'name', 'permIds', 'banEmail', 'availDomain']),
		annotations: WRITE,
		handler: (c, args) => roleService.setRole(c, args)
	},
	{
		name: 'role_set_default',
		description: 'Set the default role. PUT /role/setDefault',
		inputSchema: schema({
			roleId: int('Role id')
		}, ['roleId']),
		annotations: WRITE,
		handler: (c, args) => roleService.setDefault(c, args)
	},
	{
		name: 'role_delete',
		description: 'Delete a role and move its users to the default role. DELETE /role/delete',
		inputSchema: schema({
			roleId: int('Role id')
		}, ['roleId']),
		annotations: DESTROY,
		handler: (c, args) => roleService.delete(c, args)
	},
	{
		name: 'reg_key_list',
		description: 'List invite codes. GET /regKey/list',
		inputSchema: schema({
			code: str('Code prefix')
		}),
		annotations: READ,
		handler: (c, args) => regKeyService.list(c, args)
	},
	{
		name: 'reg_key_history',
		description: 'List users registered with an invite code. GET /regKey/history',
		inputSchema: schema({
			regKeyId: int('Invite code id')
		}, ['regKeyId']),
		annotations: READ,
		handler: (c, args) => regKeyService.history(c, args)
	},
	{
		name: 'reg_key_add',
		description: 'Create an invite code. POST /regKey/add',
		inputSchema: schema({
			code: str('Invite code'),
			roleId: int('Role granted to new users'),
			count: int('Remaining uses'),
			expireTime: str('Expiry time')
		}, ['code', 'roleId', 'count', 'expireTime']),
		annotations: WRITE,
		handler: (c, args) => regKeyService.add(c, args, userId(c))
	},
	{
		name: 'reg_key_delete',
		description: 'Delete invite codes. DELETE /regKey/delete',
		inputSchema: schema({
			regKeyIds: str('Comma-separated invite code ids')
		}, ['regKeyIds']),
		annotations: DESTROY,
		handler: (c, args) => regKeyService.delete(c, args)
	},
	{
		name: 'reg_key_clear_not_use',
		description: 'Delete invite codes that are used up or expired. DELETE /regKey/clearNotUse',
		inputSchema: schema(),
		annotations: DESTROY,
		handler: (c) => regKeyService.clearNotUse(c)
	},
	{
		name: 'star_list',
		description: 'List starred messages of the administrator. GET /star/list',
		inputSchema: schema({
			emailId: int('Cursor email id'),
			size: int('Page size'),
			full: int('1 returns full content, 0 returns a brief row')
		}),
		annotations: READ,
		handler: (c, args) => starService.list(c, args, userId(c))
	},
	{
		name: 'star_add',
		description: 'Star a message. POST /star/add',
		inputSchema: schema({
			emailId: int('Email id')
		}, ['emailId']),
		annotations: WRITE,
		handler: (c, args) => starService.add(c, args, userId(c))
	},
	{
		name: 'star_cancel',
		description: 'Remove a star. DELETE /star/cancel',
		inputSchema: schema({
			emailId: int('Email id')
		}, ['emailId']),
		annotations: WRITE,
		handler: (c, args) => starService.cancel(c, args, userId(c))
	},
	{
		name: 'setting_query',
		description: 'Read site settings. Secrets are masked and the full MCP token is not returned. GET /setting/query',
		inputSchema: schema(),
		annotations: READ,
		handler: (c) => settingService.get(c)
	},
	{
		name: 'setting_website_config',
		description: 'Read the public website configuration. GET /setting/websiteConfig',
		inputSchema: schema(),
		annotations: READ,
		handler: (c) => settingService.websiteConfig(c)
	},
	{
		name: 'setting_set',
		description: 'Update site settings. This can change the whole site. Omit masked secrets instead of writing them back. PUT /setting/set',
		inputSchema: schema({
			register: int('0 enabled, 1 disabled'),
			receive: int('0 enabled, 1 disabled'),
			title: str('Site title'),
			manyEmail: int('0 enabled, 1 disabled'),
			addEmail: int('0 enabled, 1 disabled'),
			autoRefresh: int('Auto refresh seconds, 0 disabled'),
			addEmailVerify: int('Add-mailbox verification mode'),
			registerVerify: int('Sign-up verification mode'),
			regVerifyCount: int('Sign-up verification threshold'),
			addVerifyCount: int('Add-mailbox verification threshold'),
			send: int('0 send enabled, 1 disabled'),
			r2Domain: str('Object storage domain'),
			secretKey: str('Turnstile secret'),
			siteKey: str('Turnstile site key'),
			regKey: int('Invite code mode'),
			background: str('Login background'),
			tgBotToken: str('Telegram bot token'),
			tgChatId: str('Telegram chat ids'),
			tgBotStatus: int('0 enabled, 1 disabled'),
			forwardEmail: str('Forwarding addresses'),
			forwardStatus: int('0 enabled, 1 disabled'),
			ruleEmail: str('Forwarding rule addresses'),
			ruleType: int('0 forward all, otherwise rules'),
			loginOpacity: { type: 'number', description: 'Login box opacity' },
			resendTokens: { type: 'object', description: 'Domain to Resend token map' },
			noticeTitle: str('Notice title'),
			noticeContent: str('Notice HTML'),
			noticeType: str('Notice type'),
			noticeDuration: int('Notice duration'),
			noticePosition: str('Notice position'),
			noticeOffset: int('Notice offset'),
			noticeWidth: int('Notice width'),
			notice: int('0 enabled, 1 disabled'),
			noRecipient: int('Accept mail with no local recipient'),
			loginDomain: int('Hide domains on the login page when 1'),
			bucket: str('S3 bucket'),
			region: str('S3 region'),
			endpoint: str('S3 endpoint'),
			s3AccessKey: str('S3 access key'),
			s3SecretKey: str('S3 secret key'),
			forcePathStyle: int('Path-style access'),
			customDomain: str('Worker custom domain'),
			tgMsgFrom: str('Telegram sender display'),
			tgMsgTo: str('Telegram recipient display'),
			tgMsgText: str('Telegram body display'),
			minEmailPrefix: int('Minimum mailbox prefix length'),
			emailPrefixFilter: str('Comma-separated banned prefix fragments'),
			blackSubject: str('Subject block list'),
			blackContent: str('Content block list'),
			blackFrom: str('Sender block list'),
			aiCode: int('0 verification-code recognition enabled, 1 disabled'),
			syncDelete: int('0 physical delete, 1 soft delete'),
			aiCodeFilter: str('Comma-separated recognition filters'),
			linuxdoClientId: str('LinuxDo client id'),
			linuxdoClientSecret: str('LinuxDo client secret'),
			linuxdoSwitch: int('0 enabled, 1 disabled'),
			githubClientId: str('GitHub client id'),
			githubClientSecret: str('GitHub client secret'),
			githubSwitch: int('0 enabled, 1 disabled'),
			googleClientId: str('Google client id'),
			googleClientSecret: str('Google client secret'),
			googleSwitch: int('0 enabled, 1 disabled'),
			autoCleanDays: int('Retention days, 0 disables cleanup'),
			autoCleanExclude: str('Comma-separated excluded user emails'),
			webhookUrl: str('Webhook URL'),
			webhookStatus: int('0 enabled, 1 disabled'),
			webhookRetry: int('Webhook retries'),
			webhookSecret: str('Webhook secret'),
			mcpStatus: int('0 MCP enabled, 1 disabled'),
			mcpToken: str('MCP access token. Do not write a masked value back')
		}),
		annotations: WRITE,
		handler: (c, args) => settingService.set(c, args)
	},
	{
		name: 'setting_set_blacklist',
		description: 'Replace the mail block lists. PUT /setting/setBlacklist',
		inputSchema: schema({
			blackSubject: str('Subject block list'),
			blackContent: str('Content block list'),
			blackFrom: str('Sender block list')
		}),
		annotations: WRITE,
		handler: (c, args) => settingService.setBlacklist(c, args)
	},
	{
		name: 'analysis_echarts',
		description: 'Read dashboard chart data. GET /analysis/echarts',
		inputSchema: schema({
			timeZone: str('IANA time zone, for example Asia/Shanghai')
		}),
		annotations: READ,
		handler: (c, args) => analysisService.echarts(c, args)
	},
	{
		name: 'my_login_user_info',
		description: 'Return the administrator profile used by this MCP token. GET /my/loginUserInfo',
		inputSchema: schema(),
		annotations: READ,
		handler: (c) => userService.loginUserInfo(c, userId(c))
	}
];

function toolView(tool) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		annotations: tool.annotations
	};
}

export async function dispatch(c, body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { status: 200, body: rpcError(null, -32600, 'Invalid Request') };
	}

	const id = Object.prototype.hasOwnProperty.call(body, 'id') ? body.id : null;
	const method = body.method;

	if (typeof method !== 'string' || !method) {
		return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
	}

	if (method.startsWith('notifications/')) {
		return { status: 204, body: null };
	}

	if (method === 'initialize') {
		const protocolVersion = body.params?.protocolVersion || PROTOCOL_VERSION;
		return {
			status: 200,
			body: rpcOk(id, {
				protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: 'cloud-mail', version: SERVER_VERSION }
			})
		};
	}

	if (method === 'ping') {
		return { status: 200, body: rpcOk(id, {}) };
	}

	if (method === 'tools/list') {
		return {
			status: 200,
			body: rpcOk(id, { tools: tools.map(toolView) })
		};
	}

	if (method === 'tools/call') {
		const params = body.params && typeof body.params === 'object' ? body.params : {};
		const name = params.name;
		if (typeof name !== 'string' || !name) {
			return { status: 200, body: rpcError(id, -32602, 'Invalid params') };
		}

		if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) {
			return { status: 200, body: rpcError(id, -32602, 'Invalid params') };
		}

		const args = params.arguments || {};
		const tool = tools.find(item => item.name === name);
		if (!tool) {
			return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
		}

		const missing = (tool.inputSchema.required || []).filter(key => args[key] === undefined || args[key] === null);
		if (missing.length) {
			return { status: 200, body: rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`) };
		}

		try {
			const data = await tool.handler(c, args);
			const payload = data === undefined ? null : data;
			return {
				status: 200,
				body: rpcOk(id, {
					content: [{ type: 'text', text: JSON.stringify(payload) }],
					structuredContent: payload
				})
			};
		} catch (error) {
			if (error instanceof BizError || error?.name === 'BizError') {
				return {
					status: 200,
					body: rpcOk(id, {
						content: [{ type: 'text', text: error.message }],
						isError: true
					})
				};
			}
			throw error;
		}
	}

	return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

const mcpService = {
	tools,
	toolCount() {
		return tools.length;
	},
	authorizeMcpToken,
	dispatch,
	async handle(c) {
		let text = '';
		try {
			text = await c.req.text();
		} catch (error) {
			return c.json(rpcError(null, -32700, 'Parse error'));
		}

		if (!text || !text.trim()) {
			return c.json(rpcError(null, -32700, 'Parse error'));
		}

		let body;
		try {
			body = JSON.parse(text);
		} catch (error) {
			return c.json(rpcError(null, -32700, 'Parse error'));
		}

		const result = await dispatch(c, body);
		if (result.status === 204) {
			return c.body(null, 204);
		}
		return c.json(result.body, result.status);
	}
};

export default mcpService;
