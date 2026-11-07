import app from '../hono/hono';
import result from '../model/result';
import settingService from '../service/setting-service';
import userContext from "../security/user-context";
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import mcpService from '../service/mcp-service';

function assertAdmin(c) {
	const user = userContext.getUser(c);
	if (!user || user.email !== c.env.admin) {
		throw new BizError(t('unauthorized'), 403);
	}
}

app.put('/setting/set', async (c) => {
	await settingService.set(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/setting/query', async (c) => {
	const setting = await settingService.get(c);
	return c.json(result.ok(setting));
});

app.get('/setting/websiteConfig', async (c) => {
	const setting = await settingService.websiteConfig(c);
	return c.json(result.ok(setting));
})

app.put('/setting/setBackground', async (c) => {
	const key = await settingService.setBackground(c, await c.req.json());
	return c.json(result.ok(key));
});

app.delete('/setting/deleteBackground', async (c) => {
	await settingService.deleteBackground(c);
	return c.json(result.ok());
});

app.put('/setting/setBlacklist', async (c) => {
	const setting = await settingService.setBlacklist(c, await c.req.json());
	return c.json(result.ok(setting));
})

app.get('/setting/mcp', async (c) => {
	assertAdmin(c);
	const settingRow = await settingService.query(c);
	return c.json(result.ok({
		status: settingRow.mcpStatus,
		token: settingRow.mcpToken || '',
		endpoint: '/mcp',
		toolCount: mcpService.toolCount()
	}));
});

app.post('/setting/mcp/token', async (c) => {
	assertAdmin(c);
	const data = await settingService.rotateMcpToken(c);
	return c.json(result.ok(data));
});

app.delete('/setting/mcp/token', async (c) => {
	assertAdmin(c);
	await settingService.clearMcpToken(c);
	return c.json(result.ok());
});

