import app from '../hono/hono';
import mcpService from '../service/mcp-service';

app.post('/mcp', async (c) => {
	return mcpService.handle(c);
});

app.get('/mcp', (c) => {
	return c.body(null, 405);
});
