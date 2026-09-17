import type { AvatarId } from './domain.js';
export interface JoinResponse { participantId: string; livekitUrl: string; token: string }
type Fetcher = typeof fetch;
const request = async <T>(path: string, init: RequestInit, fetcher: Fetcher): Promise<T> => { const response = await fetcher(path, init); const payload = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(payload.error ?? 'network_error'); return payload; };
export const createRoom = async (fetcher: Fetcher = fetch): Promise<string> => (await request<{ roomId: string }>('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' } }, fetcher)).roomId;
export const joinRoom = (roomId: string, identity: { nickname: string; avatarId: AvatarId }, fetcher: Fetcher = fetch): Promise<JoinResponse> => request(`/api/rooms/${encodeURIComponent(roomId)}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(identity) }, fetcher);
