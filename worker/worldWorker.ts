export { WorldRoom } from './worldRoom';

// Only Durable Object bindings reach room storage. There is no public HTTP API.
export default { fetch() { return new Response('Not found', { status: 404 }); } };
