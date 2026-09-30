import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {createPortalServer} from './portal.mjs';
const server=await createPortalServer();
await server.connect(new StdioServerTransport());
