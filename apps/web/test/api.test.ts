import { describe, expect, it, vi } from 'vitest';
import { createRoom, joinRoom } from '../src/api.js';

describe('房间 API 客户端', () => {
  it('创建房间并返回邀请使用的房间 ID', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ roomId: 'room_a' }), { status: 201 }));
    await expect(createRoom(fetcher)).resolves.toBe('room_a');
    expect(fetcher).toHaveBeenCalledWith('/api/rooms', expect.objectContaining({ method: 'POST' }));
  });

  it('带身份信息加入房间', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ participantId: 'p1', livekitUrl: 'wss://rtc', token: 'token' })));
    await expect(joinRoom('room_a', { nickname: '阿北', avatarId: 'owl' }, fetcher)).resolves.toMatchObject({ token: 'token' });
  });
});
