export * from './common.js';
export * from './models/index.js';
export * from './http/index.js';
export * from './realtime/index.js';

/** Base path every gateway HTTP route lives under. */
export const API_BASE_PATH = '/api/v1';

/**
 * Names the Rocket.Chat server a request is scoped to.
 *
 * A session can be signed in to several servers at once, and ids — rooms,
 * messages, users — are only unique within one of them. Omitting the header
 * targets the session's default server, so single-server clients never set it.
 */
export const SERVER_ID_HEADER = 'x-server-id';
