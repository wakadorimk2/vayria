import { createServer } from 'vite';
process.env.VITE_MANIFESTATION_ENABLED = 'true';
process.env.VITE_WORLD_MUTATION_ENABLED = 'false';
const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : undefined;
const server = await createServer({ server: { ...(port ? { port, strictPort: true } : {}) } });
await server.listen();
server.printUrls();
